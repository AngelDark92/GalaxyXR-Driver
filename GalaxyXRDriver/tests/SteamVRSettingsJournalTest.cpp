#include "../src/Config/SteamVRSettingsJournal.h"
#include <iostream>
#include <functional>
#include <vector>

using gxrsettings::Json;
static int checks = 0;
static int failures = 0;
static void Check(bool success, const char* message) {
    ++checks;
    if (!success) { ++failures; std::cerr << "FAIL: " << message << '\n'; }
}
static Json Journal() {
    return {{"schema", 1}, {"driver", "GalaxyXRNative"}, {"entries", Json::object()}};
}
static bool Rejects(Json journal, const Json& settings = Json::object()) {
    try { gxrsettings::RecordChange(journal, settings, "driver_vrlink", "test", true, 42); }
    catch (const std::exception&) { return true; }
    return false;
}
int main() {
    auto journal = Journal();
    const Json absent = Json::object();
    gxrsettings::RecordChange(journal, absent, "driver_vrlink", "test", true, 42);
    Check(journal["entries"]["driver_vrlink"]["test"] == Json({{"present", false}, {"lastPresent", true}, {"lastValue", 42}}), "absent original retained as absence");
    Check(journal["sectionPresence"]["driver_vrlink"] == false, "absent section recorded");
    const Json changed = {{"driver_vrlink", {{"test", 42}, {"second", true}}}};
    gxrsettings::RecordChange(journal, changed, "driver_vrlink", "test", true, 99);
    Check(journal["entries"]["driver_vrlink"]["test"]["present"] == false, "repeat mutation preserves original absence");
    Check(journal["entries"]["driver_vrlink"]["test"]["lastValue"] == 99, "repeat mutation tracks latest intent");
    gxrsettings::RecordChange(journal, changed, "driver_vrlink", "second", false, nullptr);
    Check(journal["sectionPresence"]["driver_vrlink"] == false, "later key does not replace original section presence");
    Check(journal["entries"]["driver_vrlink"]["second"] == Json({{"present", true}, {"value", true}, {"lastPresent", false}}), "removal keeps original and omits lastValue");
    for (const auto& value : std::vector<Json>{nullptr, false, 0, 0.5, "original", Json::array({1, 2}), Json::object({{"a", 1}})}) {
        auto rawJournal = Journal();
        const Json raw = {{"driver_vrlink", {{"test", value}}}};
        gxrsettings::RecordChange(rawJournal, raw, "driver_vrlink", "test", true, 123);
        gxrsettings::RecordChange(rawJournal, changed, "driver_vrlink", "test", false, nullptr);
        const auto& entry = rawJournal["entries"]["driver_vrlink"]["test"];
        Check(entry["present"] == true && entry["value"] == value, "raw original survives overwrite then removal");
        Check(entry["lastPresent"] == false && !entry.contains("lastValue"), "removal clears previous latest value");
    }
    auto emptySectionJournal = Journal();
    gxrsettings::RecordChange(emptySectionJournal, {{"driver_vrlink", Json::object()}}, "driver_vrlink", "test", true, 1);
    Check(emptySectionJournal["sectionPresence"]["driver_vrlink"] == true, "original empty section retained");
    Check(Rejects(nullptr), "reject null journal");
    auto bad = Journal(); bad["schema"] = 2; Check(Rejects(bad), "reject unknown schema");
    bad = Journal(); bad["driver"] = "vrlink"; Check(Rejects(bad), "reject other driver journal");
    bad = Journal(); bad["entries"] = nullptr; Check(Rejects(bad), "reject invalid entries");
    bad = Journal(); bad["entries"]["driver_vrlink"] = false; Check(Rejects(bad), "reject invalid journal section");
    bad = Journal(); bad["entries"]["driver_vrlink"]["test"] = false; Check(Rejects(bad), "reject invalid entry");
    bad = Journal(); bad["entries"]["driver_vrlink"]["test"] = {{"present", "yes"}}; Check(Rejects(bad), "reject invalid original presence");
    bad = Journal(); bad["entries"]["driver_vrlink"]["test"] = {{"present", true}}; Check(Rejects(bad), "reject original present without value");
    bad = Journal(); bad["sectionPresence"] = nullptr; Check(Rejects(bad), "reject invalid sectionPresence map");
    bad = Journal(); bad["sectionPresence"]["driver_vrlink"] = "yes"; Check(Rejects(bad), "reject corrupt recorded section presence");
    bad = Journal(); bad["sectionPresence"]["other_section"] = 1; Check(Rejects(bad), "reject corrupt unrelated section presence");
    bad = Journal(); bad["entries"]["other_section"]["other_key"] = {{"present", false}, {"lastPresent", true}}; Check(Rejects(bad), "reject unrelated latest value missing");
    bad = Journal(); bad["entries"]["driver_vrlink"]["test"] = {{"present", false}, {"lastPresent", "yes"}}; Check(Rejects(bad), "reject invalid latest presence");
    bad = Journal(); bad["entries"]["driver_vrlink"]["test"] = {{"present", false}}; Check(Rejects(bad), "reject missing latest presence");
    Check(Rejects(Journal(), {{"driver_vrlink", nullptr}}), "reject raw non-object settings section");
    // ---- lossless JSON (out-of-range numeric tokens) ----
    using gxrjson::ParseLossless; using gxrjson::DumpLossless; using gxrjson::IsOpaqueNumber;
    const auto Throws = [](const std::string& text) {
        try { ParseLossless(text); } catch (const std::exception&) { return true; }
        return false;
    };
    {
        const auto doc = ParseLossless("{\"a\":-1e+9999,\"b\":1e+9999,\"c\":-1e-9999,\"d\":123456789012345678901234567890,"
            "\"e\":18446744073709551615,\"f\":18446744073709551616,\"g\":-9223372036854775809,\"h\":0.5,\"i\":7}");
        Check(IsOpaqueNumber(doc["a"]) && gxrjson::OpaqueNumberToken(doc["a"]) == "-1e+9999", "-1e+9999 retained as opaque token");
        Check(IsOpaqueNumber(doc["b"]) && IsOpaqueNumber(doc["c"]), "+overflow and underflow retained");
        Check(IsOpaqueNumber(doc["d"]) && gxrjson::OpaqueNumberToken(doc["d"]) == "123456789012345678901234567890", "integer beyond uint64 retained exactly");
        Check(doc["e"].is_number_unsigned() && doc["e"] == 18446744073709551615ULL, "uint64 max stays a normal number");
        Check(IsOpaqueNumber(doc["f"]) && IsOpaqueNumber(doc["g"]), "one past uint64/int64 retained");
        Check(doc["h"] == 0.5 && doc["i"] == 7, "ordinary numbers unchanged");
        Check(!doc["a"].is_number() && !doc["a"].is_string() && !doc["a"].is_boolean(), "opaque number is not a settable scalar");
        const std::string out = DumpLossless(doc);
        for (const char* token : {"-1e+9999", "1e+9999", "-1e-9999", "123456789012345678901234567890", "18446744073709551616", "-9223372036854775809"})
            Check(out.find(token) != std::string::npos, "serialization emits the original token");
        Check(DumpLossless(ParseLossless(out)) == out, "serialize/parse is a fixpoint");
    }
    {
        // ordinary documents serialize exactly like nlohmann dump(2)
        const Json plain = {{"z", Json::array({1, 2.5, "x", nullptr, Json::object()})}, {"a", {{"k", true}}}, {"e", Json::array()}, {"s", "q\"\\\n"}};
        Check(DumpLossless(plain) == plain.dump(2), "ordinary document layout identical to dump(2)");
        Check(ParseLossless(plain.dump(2)) == plain, "ordinary document round trips");
    }
    {
        // collision safety: strings/keys that look like tokens or placeholders never become numbers
        const std::string seed = std::to_string(gxrjson::kPlaceholderSeed);
        const std::string next = std::to_string(gxrjson::kPlaceholderSeed + 1);
        const auto doc = ParseLossless("{\"s\":\"-1e+9999\",\"t\":\"" + seed + "\",\"-1e+9999\":1,\"esc\":\"-1e\\u002b9999\","
            "\"a\":-1e+9999,\"b\":" + seed + ",\"c\":" + next + ",\"d\":18446744073709551616}");
        Check(doc["s"].is_string() && doc["s"] == "-1e+9999", "string that looks like an overflow token stays a string");
        Check(doc["t"].is_string() && doc["t"] == seed, "string equal to a placeholder stays a string");
        Check(doc.contains("-1e+9999") && doc["-1e+9999"] == 1, "key that looks like a token stays a key");
        Check(doc["esc"].is_string() && doc["esc"] == "-1e+9999", "escaped string stays a string");
        Check(IsOpaqueNumber(doc["a"]) && gxrjson::OpaqueNumberToken(doc["a"]) == "-1e+9999", "real overflow token still recognised beside colliding input");
        Check(doc["b"].is_number_unsigned() && doc["b"] == gxrjson::kPlaceholderSeed, "source integer equal to the first placeholder candidate stays a number");
        Check(doc["c"].is_number_unsigned() && doc["c"] == gxrjson::kPlaceholderSeed + 1, "source integer equal to the second candidate stays a number");
        Check(IsOpaqueNumber(doc["d"]) && gxrjson::OpaqueNumberToken(doc["d"]) == "18446744073709551616", "second opaque token recovered exactly");
        // tokens inside comments and strings are not rewritten
        const auto commented = ParseLossless("{ /* -1e+9999 */ \"a\": 1, // -1e+9999\n \"b\": \"x /* -1e+9999 */\" }");
        Check(commented["a"] == 1 && commented["b"] == "x /* -1e+9999 */", "comments and string contents handled like the old reader");
    }
    Check(Throws("{\"a\":1e}") && Throws("{\"a\":01}") && Throws("{\"a\":-}") && Throws("{\"a\":1e+}") && Throws("{\"a\":+1}")
        && Throws("{\"a\":.5}") && Throws("{\"a\":1.}") && Throws("{\"a\":1,") && Throws("{\"a\":1} x") && Throws("{\"a\":-1e+9999") && Throws(""),
        "malformed JSON and invalid numeric lexemes fail closed");
    Check(!Throws("{\"a\":-1e+9999,\"b\":[1e+9999,{\"c\":-1e-9999}]}"), "opaque tokens nested in containers parse");
    {
        // comments are an opt-in matching the old journal reader; DriverLockout disables them
        bool rejected = false;
        try { ParseLossless("{ /* c */ \"a\": 1 }", false); } catch (const std::exception&) { rejected = true; }
        Check(rejected, "comments rejected when not allowed");
    }
    {
        // opaque tokens in journals: ownership comparison and native restore planning
        auto overflowJournal = Journal();
        const auto settings = ParseLossless("{\"driver_vrlink\":{\"streamFormatWidth\":-1e+9999,\"other\":3}}");
        gxrsettings::RecordChange(overflowJournal, settings, "driver_vrlink", "streamFormatWidth", true, 1536);
        gxrsettings::RecordChange(overflowJournal, settings, "driver_vrlink", "other", true, 4);
        const auto& entry = overflowJournal["entries"]["driver_vrlink"]["streamFormatWidth"];
        Check(entry["present"] == true && IsOpaqueNumber(entry["value"]), "journal keeps opaque original value");
        const std::string text = DumpLossless(overflowJournal);
        Check(text.find("\"value\": -1e+9999") != std::string::npos && text.find("\"lastValue\": 1536") != std::string::npos, "journal text carries original token and written value");
        const auto reparsed = ParseLossless(text);
        Check(reparsed == overflowJournal, "journal survives serialize/parse");
        bool present = false; Json value;
        const Json now = {{"driver_vrlink", {{"streamFormatWidth", 1536}, {"other", 4}}}};
        Check(!gxrsettings::PlanOwnedRestore(reparsed["entries"]["driver_vrlink"]["streamFormatWidth"], now, "driver_vrlink", "streamFormatWidth", present, value),
            "unrepresentable baseline is never planned for native restore");
        Check(gxrsettings::PlanOwnedRestore(reparsed["entries"]["driver_vrlink"]["other"], now, "driver_vrlink", "other", present, value) && present && value == 3,
            "ordinary entry beside an opaque one still restores");
        const Json changed = {{"driver_vrlink", {{"streamFormatWidth", 2000}, {"other", 5}}}};
        Check(!gxrsettings::PlanOwnedRestore(reparsed["entries"]["driver_vrlink"]["other"], changed, "driver_vrlink", "other", present, value),
            "later external change is protected");
        // an opaque *current* value is compared by token, never as a number
        const auto liveOpaque = ParseLossless("{\"driver_vrlink\":{\"k\":-1e+9999}}");
        auto j2 = Journal();
        gxrsettings::RecordChange(j2, Json::object(), "driver_vrlink", "k", true, Json(ParseLossless("{\"v\":-1e+9999}")["v"]));
        Check(gxrsettings::PlanOwnedRestore(j2["entries"]["driver_vrlink"]["k"], liveOpaque, "driver_vrlink", "k", present, value) && !present,
            "an identical opaque last value proves ownership of an absent original (removal needs no numeric API)");
        auto j3 = Journal();
        gxrsettings::RecordChange(j3, liveOpaque, "driver_vrlink", "k", true, 1);
        const auto otherToken = ParseLossless("{\"driver_vrlink\":{\"k\":-1e+9998}}");
        Check(!gxrsettings::PlanOwnedRestore(j3["entries"]["driver_vrlink"]["k"], otherToken, "driver_vrlink", "k", present, value),
            "different out-of-range token is not ownership");
        // numeric representability for native restore
        const auto Restorable = [&](const Json& original, const Json& last) {
            auto j = Journal();
            gxrsettings::RecordChange(j, Json({{"s", {{"k", original}}}}), "s", "k", true, last);
            bool p = false; Json v;
            return gxrsettings::PlanOwnedRestore(j["entries"]["s"]["k"], Json({{"s", {{"k", last}}}}), "s", "k", p, v);
        };
        Check(Restorable(5, 6) && Restorable(0.5, 0.75) && Restorable("a", "b") && Restorable(true, false), "ordinary scalar originals restore");
        Check(!Restorable(2147483648LL, 1) && !Restorable(-2147483649LL, 1), "integers outside int32 are not restorable");
        Check(!Restorable(1e300, 1.5) && !Restorable(-1e300, 1.5), "floats outside float range are not restorable");
        Check(!Restorable(1e-300, 1.5), "floats that would collapse to zero are not restorable");
    }
    std::cout << (failures ? "FAIL: " : "PASS: ") << checks << " journal checks; " << failures << " failures.\n";
    return failures ? 1 : 0;
}
