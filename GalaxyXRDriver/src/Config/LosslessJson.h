#pragma once
// Lossless reader/writer for SteamVR settings and recovery journals.
//
// SteamVR (and Companion's serde_json "arbitrary_precision") can persist number
// tokens that nlohmann::json refuses to parse (-1e+9999, error 406) or would
// silently degrade (integers beyond uint64, values that underflow to zero). A
// plain Json::parse then rejects the whole file, which used to fail EVERY
// journaled SteamVR mutation and restoration.
//
// Design:
//  * ParseLossless scans the text with the same lexical rules the existing
//    reader used (strings with escapes, optional // and block comments) and
//    rewrites each number token nlohmann cannot represent faithfully into a
//    unique unsigned integer placeholder. The placeholder values are chosen so
//    that no integer lexeme of the source equals one, and they are recognised
//    by value in a SAX callback, never by string content: no string, key or
//    ordinary number can be mistaken for an original token.
//  * The recognised token is kept verbatim as a nlohmann *binary* value with a
//    dedicated subtype. JSON text can never produce a binary value, so an
//    opaque number is never a string, never a settable scalar (is_number() is
//    false), and compares equal only to the identical token.
//  * DumpLossless writes the document in the same layout as dump(2) and emits
//    each opaque number's original token byte-for-byte.
//  * Malformed JSON and invalid numeric lexemes are left untouched by the scan
//    and rejected by the parser (fail closed).
#include "nlohmann/json.hpp"
#include <cerrno>
#include <cmath>
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <map>
#include <set>
#include <stdexcept>
#include <string>
#include <vector>

namespace gxrjson {
using Json = nlohmann::json;

constexpr std::uint8_t kOpaqueNumberSubtype = 0x4E;
// First candidate for placeholder integers; advanced until it cannot collide
// with any integer lexeme present in the source text.
constexpr std::uint64_t kPlaceholderSeed = 0x7A3F5C1D00000000ULL;

inline bool IsOpaqueNumber(const Json& value) {
    return value.is_binary() && value.get_binary().has_subtype()
        && value.get_binary().subtype() == kOpaqueNumberSubtype;
}

inline std::string OpaqueNumberToken(const Json& value) {
    const auto& bytes = value.get_binary();
    return std::string(bytes.begin(), bytes.end());
}

namespace detail {
inline bool IsDigit(char c) { return c >= '0' && c <= '9'; }

// Strict RFC 8259 number grammar.
inline bool ValidNumber(const std::string& t) {
    size_t i = 0; const size_t n = t.size();
    if (i < n && t[i] == '-') ++i;
    if (i >= n) return false;
    if (t[i] == '0') ++i;
    else if (t[i] >= '1' && t[i] <= '9') { while (i < n && IsDigit(t[i])) ++i; }
    else return false;
    if (i < n && t[i] == '.') {
        ++i; const size_t start = i;
        while (i < n && IsDigit(t[i])) ++i;
        if (i == start) return false;
    }
    if (i < n && (t[i] == 'e' || t[i] == 'E')) {
        ++i;
        if (i < n && (t[i] == '+' || t[i] == '-')) ++i;
        const size_t start = i;
        while (i < n && IsDigit(t[i])) ++i;
        if (i == start) return false;
    }
    return i == n;
}

// True when nlohmann cannot hold the token without failing or losing digits.
inline bool NeedsOpaque(const std::string& t) {
    const bool fractional = t.find_first_of(".eE") != std::string::npos;
    char* end = nullptr;
    errno = 0;
    if (!fractional) {
        if (t[0] == '-') std::strtoll(t.c_str(), &end, 10);
        else std::strtoull(t.c_str(), &end, 10);
        return errno == ERANGE; // beyond int64/uint64
    }
    const double d = std::strtod(t.c_str(), &end);
    if (!std::isfinite(d)) return true; // overflow (error 406)
    if (d == 0.0 || std::fpclassify(d) == FP_SUBNORMAL) {
        // Underflow: a non-zero mantissa that collapsed to zero/denormal.
        for (const char c : t) {
            if (c == 'e' || c == 'E') break;
            if (c >= '1' && c <= '9') return true;
        }
    }
    return false;
}

class Builder : public nlohmann::json_sax<Json> {
public:
    explicit Builder(const std::map<std::uint64_t, std::string>& opaque) : opaque_(opaque) {}
    Json root;

    bool null() override { return Add(Json(nullptr)); }
    bool boolean(bool v) override { return Add(Json(v)); }
    bool number_integer(number_integer_t v) override { return Add(Json(v)); }
    bool number_unsigned(number_unsigned_t v) override {
        const auto it = opaque_.find(static_cast<std::uint64_t>(v));
        if (it != opaque_.end()) {
            const std::string& token = it->second;
            return Add(Json::binary(std::vector<std::uint8_t>(token.begin(), token.end()), kOpaqueNumberSubtype));
        }
        return Add(Json(v));
    }
    bool number_float(number_float_t v, const string_t&) override { return Add(Json(v)); }
    bool string(string_t& v) override { return Add(Json(v)); }
    bool binary(binary_t& v) override { return Add(Json(v)); }
    bool start_object(std::size_t) override { stack_.push_back(Place(Json::object())); return true; }
    bool key(string_t& v) override { key_ = v; return true; }
    bool end_object() override { stack_.pop_back(); return true; }
    bool start_array(std::size_t) override { stack_.push_back(Place(Json::array())); return true; }
    bool end_array() override { stack_.pop_back(); return true; }
    bool parse_error(std::size_t position, const std::string&, const nlohmann::detail::exception& ex) override {
        throw std::runtime_error("invalid JSON at byte " + std::to_string(position) + ": " + ex.what());
    }

private:
    Json* Place(Json value) {
        if (stack_.empty()) { root = std::move(value); return &root; }
        Json* top = stack_.back();
        if (top->is_array()) { top->push_back(std::move(value)); return &top->back(); }
        Json& slot = (*top)[key_];
        slot = std::move(value);
        return &slot;
    }
    bool Add(Json value) { Place(std::move(value)); return true; }

    const std::map<std::uint64_t, std::string>& opaque_;
    std::vector<Json*> stack_;
    std::string key_;
};
} // namespace detail

// Parse JSON text (optionally with // and block comments, matching the old
// reader). Unrepresentable numeric tokens become opaque numbers.
inline Json ParseLossless(const std::string& text, bool ignoreComments = true) {
    struct Span { size_t begin, end; };
    std::vector<Span> opaqueSpans;
    std::set<std::string> integerLexemes;
    const size_t n = text.size();
    size_t i = 0;
    while (i < n) {
        const char c = text[i];
        if (c == '"') {
            ++i;
            while (i < n && text[i] != '"') { if (text[i] == '\\') ++i; ++i; }
            i = (i < n) ? i + 1 : n;
        } else if (ignoreComments && c == '/' && i + 1 < n && text[i + 1] == '/') {
            while (i < n && text[i] != '\n') ++i;
        } else if (ignoreComments && c == '/' && i + 1 < n && text[i + 1] == '*') {
            const size_t close = text.find("*/", i + 2);
            i = (close == std::string::npos) ? n : close + 2;
        } else if (c == '-' || detail::IsDigit(c)) {
            size_t j = i;
            while (j < n && (detail::IsDigit(text[j]) || text[j] == '-' || text[j] == '+'
                || text[j] == '.' || text[j] == 'e' || text[j] == 'E')) ++j;
            const std::string token = text.substr(i, j - i);
            if (detail::ValidNumber(token)) {
                if (detail::NeedsOpaque(token)) opaqueSpans.push_back({i, j});
                else if (token.find_first_of(".eE") == std::string::npos) integerLexemes.insert(token);
            }
            i = j;
        } else {
            ++i;
        }
    }

    std::map<std::uint64_t, std::string> opaque;
    std::string rewritten;
    if (opaqueSpans.empty()) {
        rewritten = text;
    } else {
        std::uint64_t base = kPlaceholderSeed;
        for (bool clear = false; !clear;) {
            clear = true;
            for (size_t k = 0; k < opaqueSpans.size(); ++k)
                if (integerLexemes.count(std::to_string(base + k))) { clear = false; break; }
            if (!clear) base += 0x10001ULL;
        }
        size_t cursor = 0;
        for (size_t k = 0; k < opaqueSpans.size(); ++k) {
            const auto& span = opaqueSpans[k];
            rewritten.append(text, cursor, span.begin - cursor);
            rewritten += std::to_string(base + k);
            opaque[base + k] = text.substr(span.begin, span.end - span.begin);
            cursor = span.end;
        }
        rewritten.append(text, cursor, std::string::npos);
    }

    detail::Builder builder(opaque);
    if (!Json::sax_parse(rewritten, &builder, Json::input_format_t::json, true, ignoreComments))
        throw std::runtime_error("invalid JSON");
    return std::move(builder.root);
}

namespace detail {
inline void DumpInto(const Json& value, int indent, int depth, std::string& out) {
    const auto pad = [&](int level) { out.append(static_cast<size_t>(indent) * static_cast<size_t>(level), ' '); };
    if (IsOpaqueNumber(value)) { out += OpaqueNumberToken(value); return; }
    if (value.is_binary()) throw std::runtime_error("unsupported binary JSON value");
    if (value.is_object()) {
        if (value.empty()) { out += "{}"; return; }
        out += "{\n";
        bool first = true;
        for (auto it = value.begin(); it != value.end(); ++it) {
            if (!first) out += ",\n";
            first = false;
            pad(depth + 1);
            out += Json(it.key()).dump();
            out += ": ";
            DumpInto(it.value(), indent, depth + 1, out);
        }
        out += "\n"; pad(depth); out += "}";
    } else if (value.is_array()) {
        if (value.empty()) { out += "[]"; return; }
        out += "[\n";
        bool first = true;
        for (const auto& item : value) {
            if (!first) out += ",\n";
            first = false;
            pad(depth + 1);
            DumpInto(item, indent, depth + 1, out);
        }
        out += "\n"; pad(depth); out += "]";
    } else {
        out += value.dump();
    }
}
} // namespace detail

// Same layout as Json::dump(indent); opaque numbers emit their original token.
inline std::string DumpLossless(const Json& value, int indent = 2) {
    std::string out;
    detail::DumpInto(value, indent, 0, out);
    return out;
}
} // namespace gxrjson
