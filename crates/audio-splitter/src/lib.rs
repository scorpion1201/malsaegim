pub mod decode;
pub mod resample;
pub mod splitter;
pub mod wav;

use js_sys::{Array, Function, Uint8Array};
use wasm_bindgen::prelude::*;

pub use splitter::SplitConfig;

const OUT_RATE: u32 = 16_000;

#[wasm_bindgen]
#[derive(Clone, Copy)]
pub struct SplitSummary {
    pub total_ms: f64,
    pub chunk_count: u32,
    pub sample_rate: u32,
}

/// mp3 → 16kHz 모노 PCM16 WAV 조각. 조각마다 `on_chunk(index, start_ms, end_ms, wav)` 호출.
#[wasm_bindgen]
pub fn split_mp3(
    data: &[u8],
    target_secs: f32,
    max_secs: f32,
    silence_db: f32,
    on_chunk: &Function,
) -> Result<SplitSummary, JsError> {
    let cfg = SplitConfig { target_secs, max_secs, silence_db };
    let mut resampler: Option<resample::Resampler> = None;
    let mut splitter = splitter::Splitter::new(cfg, OUT_RATE);
    let mut resampled: Vec<f32> = Vec::new();
    let mut count = 0u32;
    let mut total_ms = 0f64;
    let mut callback_error: Option<JsValue> = None;

    let mut emit = |chunk: splitter::Chunk| {
        if callback_error.is_some() {
            return;
        }
        let wav = wav::encode_pcm16_mono(&wav::f32_to_i16(&chunk.samples), OUT_RATE);
        let args = Array::of4(
            &JsValue::from(chunk.index),
            &JsValue::from(chunk.start_ms),
            &JsValue::from(chunk.end_ms),
            &Uint8Array::from(wav.as_slice()).into(),
        );
        if let Err(e) = on_chunk.apply(&JsValue::NULL, &args) {
            callback_error = Some(e);
        }
        count += 1;
        total_ms = chunk.end_ms;
    };

    decode::decode_mp3(data.to_vec(), &mut |info, pcm| {
        let r = resampler.get_or_insert_with(|| resample::Resampler::new(info.sample_rate, OUT_RATE));
        resampled.clear();
        r.process(pcm, &mut resampled);
        splitter.push(&resampled, &mut emit);
    })
    .map_err(|e| JsError::new(&e))?;

    if let Some(r) = resampler.as_mut() {
        resampled.clear();
        r.flush(&mut resampled);
        splitter.push(&resampled, &mut emit);
    }
    splitter.finish(&mut emit);

    if let Some(e) = callback_error {
        return Err(JsError::new(&format!("on_chunk threw: {:?}", e)));
    }
    if count == 0 {
        return Err(JsError::new("no audio decoded"));
    }
    Ok(SplitSummary { total_ms, chunk_count: count, sample_rate: OUT_RATE })
}