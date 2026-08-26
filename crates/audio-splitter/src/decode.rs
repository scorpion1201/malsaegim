use symphonia::core::codecs::audio::AudioDecoderOptions;
use symphonia::core::codecs::CodecParameters;
use symphonia::core::errors::Error;
use symphonia::core::formats::probe::Hint;
use symphonia::core::formats::{FormatOptions, TrackType};
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::MetadataOptions;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct AudioInfo {
    pub sample_rate: u32,
    pub channels: usize,
}

/// 오디오 바이트(mp3/m4a/wav/flac/ogg 등)를 심포니아로 자동 감지·디코드해
/// 모노 f32(원본 샘플레이트)를 패킷 단위로 `on_pcm`에 넘긴다.
pub fn decode_audio(
    data: Vec<u8>,
    on_pcm: &mut impl FnMut(AudioInfo, &[f32]),
) -> Result<AudioInfo, String> {
    let mss = MediaSourceStream::new(Box::new(std::io::Cursor::new(data)), Default::default());
    // 확장자 힌트를 주지 않고 내용(매직바이트·프레임싱크)으로 포맷을 자동 감지한다.
    let hint = Hint::new();
    let mut format = symphonia::default::get_probe()
          .probe(&hint, mss, FormatOptions::default(), MetadataOptions::default())
          .map_err(|e| format!("unsupported or corrupt audio: {e}"))?;

    let track = format
          .default_track(TrackType::Audio)
          .ok_or_else(|| "no audio track".to_string())?;
    let track_id = track.id;
    let params = match &track.codec_params {
        Some(CodecParameters::Audio(p)) => p.clone(),
          _ => return Err("no audio codec parameters".into()),
      };
    let mut decoder = symphonia::default::get_codecs()
          .make_audio_decoder(&params, &AudioDecoderOptions::default())
          .map_err(|e| format!("unsupported codec: {e}"))?;

    let mut info: Option<AudioInfo> = None;
    let mut interleaved: Vec<f32> = Vec::new();
    let mut mono: Vec<f32> = Vec::new();

    loop {
        let packet = match format.next_packet() {
            Ok(Some(p)) => p,
            Ok(None) => break,
            Err(Error::ResetRequired) => {
                decoder.reset();
                continue;
              }
            Err(Error::IoError(e)) if e.kind() == std::io::ErrorKind::UnexpectedEof => break,
            Err(e) => return Err(format!("demux error: {e}")),
          };
        if packet.track_id != track_id {
            continue;
          }
        let buf = match decoder.decode(&packet) {
            Ok(b) => b,
            Err(Error::DecodeError(_)) | Err(Error::IoError(_)) => continue,
            Err(Error::ResetRequired) => {
                decoder.reset();
                continue;
              }
            Err(e) => return Err(format!("decode error: {e}")),
          };
        if buf.is_empty() {
            continue;
          }
        let spec = buf.spec();
        let channels = spec.channels().count();
        let current = AudioInfo { sample_rate: spec.rate(), channels };
        let info = *info.get_or_insert(current);
        if info != current {
            return Err("sample rate or channel layout changed mid-stream".into());
          }
        buf.copy_to_vec_interleaved::<f32>(&mut interleaved);
        mono.clear();
        mono.extend(interleaved.chunks(channels).map(|f| f.iter().sum::<f32>() / channels as f32));
        on_pcm(info, &mono);
      }

    info.ok_or_else(|| "no decodable audio".to_string())
}