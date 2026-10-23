//! Conservative structural codec identification from one encoded access unit.
//!
//! The encoded bytes, never the configured codec or a decoder MIME name, are
//! the input. Ordinary parameter-set-free frames remain unverified. The
//! same-generation retained-header path is limited to parameter units, never
//! an old coded picture.

const MAX_SAMPLE_BYTES: usize = 8 * 1024 * 1024;
const MAX_PARAMETER_BYTES: usize = 64 * 1024;
const MAX_UNITS: usize = 4096;

#[derive(Clone, Debug)]
pub struct Classification {
    pub codec: Option<&'static str>,
    pub label: &'static str,
    pub evidence: String,
}

impl Classification {
    fn unverified(evidence: impl Into<String>) -> Self {
        Self { codec: None, label: "Unverified", evidence: evidence.into() }
    }
}

pub fn classify_frame(data: &[u8], complete: bool) -> Classification {
    if !complete {
        return Classification::unverified("Frame capture is truncated");
    }
    if data.is_empty() || data.len() > MAX_SAMPLE_BYTES {
        return Classification::unverified("A nonempty encoded sample of at most 8 MiB is required");
    }
    let mut matches: Vec<Classification> = Vec::new();
    if let Ok(details) = classify_h264(data) {
        matches.push(Classification {
            codec: Some("H.264"),
            label: "H.264 / AVC",
            evidence: format!("{details}; structural byte evidence, not decoded-picture integrity"),
        });
    }
    if let Ok(details) = classify_hevc(data) {
        matches.push(Classification {
            codec: Some("HEVC"),
            label: "HEVC / H.265",
            evidence: format!("{details}; structural byte evidence, not decoded-picture integrity"),
        });
    }
    if let Ok(details) = classify_av1(data) {
        matches.push(Classification {
            codec: Some("AV1"),
            label: "AV1",
            evidence: format!("{details}; structural byte evidence, not decoded-picture integrity"),
        });
    }
    match matches.len() {
        1 => matches.remove(0),
        0 => Classification::unverified("No complete supported codec framing and parameter/frame evidence"),
        _ => Classification::unverified("Ambiguous sample"),
    }
}

pub struct CodecClassifier {
    generation: Option<String>,
    codec: Option<&'static str>,
    parameters: Vec<Vec<u8>>,
}

impl Default for CodecClassifier {
    fn default() -> Self {
        Self { generation: None, codec: None, parameters: Vec::new() }
    }
}

impl CodecClassifier {
    pub fn reset(&mut self) {
        self.generation = None;
        self.forget();
    }

    fn forget(&mut self) {
        self.codec = None;
        self.parameters.clear();
    }

    fn remember(&mut self, data: &[u8], codec: &'static str) {
        self.forget();
        if let Ok(units) = parameter_units(data, codec) {
            let total: usize = units.iter().map(Vec::len).sum();
            if !units.is_empty() && total <= MAX_PARAMETER_BYTES {
                self.codec = Some(codec);
                self.parameters = units;
            }
        }
    }

    pub fn classify_frame(
        &mut self,
        data: &[u8],
        generation: &str,
        complete: bool,
        header_frame: Option<&[u8]>,
    ) -> Classification {
        if self.generation.as_deref() != Some(generation) {
            self.generation = Some(generation.to_string());
            self.forget();
        }
        let direct = classify_frame(data, complete);
        if let Some(codec) = direct.codec {
            self.remember(data, codec);
            return direct;
        }
        if !complete || direct.evidence == "Ambiguous sample" {
            return direct;
        }
        if let Some(header) = header_frame {
            let classified = classify_frame(header, true);
            match classified.codec {
                Some(codec) => self.remember(header, codec),
                None => {
                    self.forget();
                    return Classification::unverified("Retained header AU did not supply complete codec evidence");
                }
            }
        }
        let Some(codec) = self.codec else { return direct };
        if self.parameters.is_empty() || data.is_empty() || data.len() > MAX_SAMPLE_BYTES {
            return direct;
        }
        let Ok(current) = parameter_units(data, codec) else { return direct };
        if current.iter().any(|unit| !self.parameters.iter().any(|known| known == unit)) {
            self.forget();
            return Classification::unverified(
                "Current frame changes parameter sets without complete matching header evidence",
            );
        }
        let mut combined = Vec::new();
        for unit in &self.parameters {
            combined.extend_from_slice(unit);
        }
        combined.extend_from_slice(data);
        let merged = classify_frame(&combined, true);
        if merged.codec != Some(codec) {
            return direct;
        }
        Classification {
            codec: merged.codec,
            label: merged.label,
            evidence: format!(
                "Current frame with validated same-generation retained parameters; {}",
                merged.evidence
            ),
        }
    }
}

fn classify_h264(data: &[u8]) -> Result<String, String> {
    let units = annex_b_units(data)?;
    let mut saw_sps = false;
    let mut saw_pps = false;
    let mut slices = 0usize;
    for unit in units {
        if unit[0] & 0x80 != 0 {
            return Err("AVC forbidden_zero_bit".into());
        }
        let kind = unit[0] & 31;
        let reference = (unit[0] >> 5) & 3;
        if !matches!(kind, 1 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12) {
            return Err("Unsupported AVC NAL unit".into());
        }
        if (matches!(kind, 5 | 7 | 8) && reference == 0)
            || (matches!(kind, 6 | 9 | 10 | 11 | 12) && reference != 0)
        {
            return Err("Invalid AVC reference header".into());
        }
        let payload = rbsp(&unit[1..])?;
        if payload.is_empty() {
            return Err("Empty AVC payload".into());
        }
        match kind {
            7 => {
                if payload.len() < 4 {
                    return Err("Truncated AVC SPS".into());
                }
                let profile = payload[0];
                if !matches!(profile, 66 | 77 | 88 | 100 | 110 | 122 | 244 | 44 | 83 | 86 | 118 | 128 | 138 | 139 | 134 | 135) {
                    return Err("Unknown AVC profile".into());
                }
                if payload[1] & 3 != 0 {
                    return Err("Reserved AVC constraint bits".into());
                }
                if payload[2] == 0 || payload[2] > 62 {
                    return Err("Invalid AVC level".into());
                }
                saw_sps = true;
            }
            8 => {
                if payload.len() < 3 {
                    return Err("Truncated AVC PPS".into());
                }
                saw_pps = true;
            }
            1 | 5 => {
                if payload.len() < 8 {
                    return Err("Insufficient AVC coded slice evidence".into());
                }
                slices += 1;
            }
            _ => {}
        }
    }
    if !saw_sps || !saw_pps || slices == 0 {
        return Err("AVC SPS/PPS and referenced coded slice required".into());
    }
    Ok(format!("Annex B; SPS/PPS and referenced coded slice; {slices} coded slice(s)"))
}

fn classify_hevc(data: &[u8]) -> Result<String, String> {
    let units = annex_b_units(data)?;
    let mut saw_vps = false;
    let mut saw_sps = false;
    let mut saw_pps = false;
    let mut slices = 0usize;
    for unit in units {
        if unit.len() < 3 || unit[0] & 0x80 != 0 || unit[1] & 7 == 0 {
            return Err("Invalid HEVC NAL header".into());
        }
        if ((unit[0] & 1) << 5) | (unit[1] >> 3) != 0 {
            return Err("Multilayer HEVC unsupported".into());
        }
        let kind = (unit[0] >> 1) & 63;
        if !matches!(kind, 0..=9 | 16..=21 | 32..=40) {
            return Err("Reserved HEVC NAL type".into());
        }
        let payload = rbsp(&unit[2..])?;
        match kind {
            32 => {
                if payload.len() < 8 {
                    return Err("Truncated HEVC VPS".into());
                }
                saw_vps = true;
            }
            33 => {
                if payload.len() < 8 {
                    return Err("Truncated HEVC SPS".into());
                }
                saw_sps = true;
            }
            34 => {
                if payload.len() < 3 {
                    return Err("Truncated HEVC PPS".into());
                }
                saw_pps = true;
            }
            0..=31 => {
                if payload.len() < 8 {
                    return Err("Insufficient HEVC coded slice evidence".into());
                }
                slices += 1;
            }
            _ => {}
        }
    }
    if !saw_vps || !saw_sps || !saw_pps || slices == 0 {
        return Err("HEVC VPS/SPS/PPS and referenced first coded slice required".into());
    }
    Ok(format!("Annex B; VPS/SPS/PPS and referenced first coded slice; {slices} coded slice(s)"))
}

struct Obu<'a> {
    kind: u8,
    payload: &'a [u8],
    raw: &'a [u8],
}

fn classify_av1(data: &[u8]) -> Result<String, String> {
    let obus = sized_obus(data)?;
    let mut sequence = false;
    let mut frames = 0usize;
    let mut pending_header = false;
    for obu in obus {
        match obu.kind {
            1 => {
                if sequence || frames > 0 || pending_header {
                    return Err("Multiple/late AV1 sequence headers unsupported".into());
                }
                if obu.payload.len() < 4 {
                    return Err("Truncated AV1 sequence header".into());
                }
                let profile = (obu.payload[0] >> 5) & 7;
                let still = (obu.payload[0] >> 4) & 1;
                let reduced = (obu.payload[0] >> 3) & 1;
                if profile > 2 || (reduced == 1 && still == 0) {
                    return Err("Invalid AV1 sequence profile/flags".into());
                }
                if !obu.payload.iter().any(|byte| *byte != 0) {
                    return Err("Invalid AV1 sequence header payload".into());
                }
                sequence = true;
            }
            2 => {
                if !obu.payload.is_empty() || pending_header {
                    return Err("Invalid AV1 temporal delimiter".into());
                }
            }
            3 | 6 => {
                if !sequence || obu.payload.len() < 8 || !obu.payload.iter().any(|byte| *byte != 0) {
                    return Err("AV1 sequence and substantive frame payload required".into());
                }
                if obu.payload[0] & 0x80 != 0 {
                    return Err("AV1 show_existing_frame is not coded frame evidence".into());
                }
                if pending_header {
                    return Err("AV1 frame header without its tile group".into());
                }
                pending_header = obu.kind == 3;
                if obu.kind == 6 {
                    frames += 1;
                }
            }
            4 => {
                if !pending_header || obu.payload.len() < 8 || !obu.payload.iter().any(|byte| *byte != 0) {
                    return Err("AV1 tile group without substantive frame header/data".into());
                }
                pending_header = false;
                frames += 1;
            }
            7 | 8 => return Err("AV1 redundant/tile-list OBUs unsupported".into()),
            _ => {}
        }
    }
    if !sequence || frames == 0 || pending_header {
        return Err("AV1 sequence header and complete sized coded-frame OBU required".into());
    }
    Ok(format!("Size-delimited OBUs; sequence header and complete coded-frame OBU; {frames} frame(s)"))
}

fn annex_b_units(data: &[u8]) -> Result<Vec<&[u8]>, String> {
    let mut starts: Vec<(usize, usize)> = Vec::new();
    let mut index = 0usize;
    while index + 2 < data.len() {
        if data[index] == 0 && data[index + 1] == 0 && data[index + 2] == 1 {
            starts.push((index, 3));
            index += 3;
            if starts.len() > MAX_UNITS {
                return Err("Too many Annex-B units in one sample".into());
            }
        } else if index + 3 < data.len()
            && data[index] == 0
            && data[index + 1] == 0
            && data[index + 2] == 0
            && data[index + 3] == 1
        {
            starts.push((index, 4));
            index += 4;
            if starts.len() > MAX_UNITS {
                return Err("Too many Annex-B units in one sample".into());
            }
        } else {
            index += 1;
        }
    }
    if starts.is_empty() || data[..starts[0].0].iter().any(|byte| *byte != 0) {
        return Err("Missing Annex-B start code".into());
    }
    let mut units = Vec::with_capacity(starts.len());
    for (position, (start, length)) in starts.iter().enumerate() {
        let end = starts.get(position + 1).map(|(next, _)| *next).unwrap_or(data.len());
        let mut unit = &data[start + length..end];
        while unit.last() == Some(&0) {
            unit = &unit[..unit.len() - 1];
        }
        if unit.is_empty() {
            return Err("Empty Annex-B NAL unit".into());
        }
        units.push(unit);
    }
    Ok(units)
}

fn rbsp(data: &[u8]) -> Result<Vec<u8>, String> {
    let mut out = Vec::with_capacity(data.len());
    let mut zeros = 0usize;
    let mut index = 0usize;
    while index < data.len() {
        let byte = data[index];
        if zeros == 2 {
            if byte == 3 {
                if index + 1 >= data.len() || data[index + 1] > 3 {
                    return Err("Invalid emulation-prevention byte".into());
                }
                zeros = 0;
                index += 1;
                continue;
            }
            if byte < 3 {
                return Err("Unescaped start-code emulation".into());
            }
        }
        out.push(byte);
        zeros = if byte == 0 { zeros + 1 } else { 0 };
        index += 1;
    }
    Ok(out)
}

fn sized_obus(data: &[u8]) -> Result<Vec<Obu<'_>>, String> {
    let mut offset = 0usize;
    let mut units = Vec::new();
    while offset < data.len() {
        if units.len() >= MAX_UNITS {
            return Err("Too many AV1 units in one sample".into());
        }
        let start = offset;
        let header = data[offset];
        offset += 1;
        let kind = (header >> 3) & 15;
        if header & 0x81 != 0 || header & 2 == 0 || !matches!(kind, 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 15) {
            return Err("Invalid or unsupported sized AV1 OBU header".into());
        }
        if header & 4 != 0 {
            if offset >= data.len() || data[offset] & 7 != 0 {
                return Err("Truncated/reserved AV1 extension header".into());
            }
            offset += 1;
        }
        let mut size = 0usize;
        let mut complete = false;
        for index in 0..8 {
            if offset >= data.len() {
                return Err("Truncated AV1 OBU length".into());
            }
            let byte = data[offset];
            offset += 1;
            size |= ((byte & 127) as usize) << (7 * index);
            if byte & 128 == 0 {
                complete = true;
                break;
            }
        }
        if !complete {
            return Err("Unbounded AV1 OBU length".into());
        }
        if size > MAX_SAMPLE_BYTES || size > data.len() - offset {
            return Err("Truncated or oversized AV1 OBU".into());
        }
        let payload = &data[offset..offset + size];
        offset += size;
        units.push(Obu { kind, payload, raw: &data[start..offset] });
    }
    Ok(units)
}

fn parameter_units(data: &[u8], codec: &'static str) -> Result<Vec<Vec<u8>>, String> {
    if codec == "AV1" {
        return Ok(sized_obus(data)?
            .into_iter()
            .filter(|obu| obu.kind == 1)
            .map(|obu| obu.raw.to_vec())
            .collect());
    }
    let kinds: &[u8] = if codec == "H.264" { &[7, 8] } else { &[32, 33, 34] };
    let shift = if codec == "H.264" { 0 } else { 1 };
    let mask = if codec == "H.264" { 31 } else { 63 };
    Ok(annex_b_units(data)?
        .into_iter()
        .filter(|unit| kinds.contains(&((unit[0] >> shift) & mask)))
        .map(|unit| {
            let mut owned = vec![0u8, 0, 0, 1];
            owned.extend_from_slice(unit);
            owned
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::{classify_frame, CodecClassifier};

    fn h264_header_au() -> Vec<u8> {
        let mut data = Vec::new();
        data.extend_from_slice(&[0, 0, 0, 1, 0x67, 100, 0, 40, 1, 2, 3]);
        data.extend_from_slice(&[0, 0, 0, 1, 0x68, 1, 2, 3]);
        data.extend_from_slice(&[0, 0, 0, 1, 0x65, 1, 2, 3, 4, 5, 6, 7, 8]);
        data
    }

    fn h264_frame_only() -> Vec<u8> {
        vec![0, 0, 0, 1, 0x41, 1, 2, 3, 4, 5, 6, 7, 8]
    }

    fn hevc_header_au() -> Vec<u8> {
        let mut data = Vec::new();
        data.extend_from_slice(&[0, 0, 0, 1, 0x40, 0x01, 1, 2, 3, 4, 5, 6, 7, 8]);
        data.extend_from_slice(&[0, 0, 0, 1, 0x42, 0x01, 1, 2, 3, 4, 5, 6, 7, 8]);
        data.extend_from_slice(&[0, 0, 0, 1, 0x44, 0x01, 1, 2, 3]);
        data.extend_from_slice(&[0, 0, 0, 1, 0x26, 0x01, 1, 2, 3, 4, 5, 6, 7, 8]);
        data
    }

    fn av1_header_au() -> Vec<u8> {
        let mut data = Vec::new();
        data.extend_from_slice(&[0x0a, 4, 0x10, 0x20, 0x30, 0x40]);
        data.extend_from_slice(&[0x32, 8, 0x10, 1, 2, 3, 4, 5, 6, 7]);
        data
    }

    #[test]
    fn identifies_all_supported_codecs_from_parameter_bearing_access_units() {
        assert_eq!(classify_frame(&h264_header_au(), true).codec, Some("H.264"));
        assert_eq!(classify_frame(&hevc_header_au(), true).codec, Some("HEVC"));
        assert_eq!(classify_frame(&av1_header_au(), true).codec, Some("AV1"));
    }

    #[test]
    fn incomplete_and_short_samples_are_unverified() {
        assert_eq!(classify_frame(&h264_header_au(), false).codec, None);
        assert_eq!(classify_frame(&[0, 0, 0, 1, 0x65], true).codec, None);
        assert_eq!(classify_frame(&[], true).codec, None);
    }

    #[test]
    fn retained_parameters_qualify_a_fresh_slice_only_frame() {
        let mut classifier = CodecClassifier::default();
        assert_eq!(classifier.classify_frame(&h264_header_au(), "session-a", true, None).codec, Some("H.264"));
        let fresh = classifier.classify_frame(&h264_frame_only(), "session-a", true, None);
        assert_eq!(fresh.codec, Some("H.264"));
        assert!(fresh.evidence.contains("retained parameters"));
    }

    #[test]
    fn a_new_generation_invalidates_retained_parameters() {
        let mut classifier = CodecClassifier::default();
        assert_eq!(classifier.classify_frame(&h264_header_au(), "session-a", true, None).codec, Some("H.264"));
        let fresh = classifier.classify_frame(&h264_frame_only(), "session-b", true, None);
        assert_eq!(fresh.codec, None);
    }
}
