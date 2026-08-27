//! whisper 할루시네이션 억제 — 무음/패딩 위 세그먼트, 반복 루프, 무음 상투구, 중복 문장을 지운다.
//! whisper.cpp 가 넘긴 세그먼트를 받아 정리한 텍스트를 돌려준다 (예전 whisper.worker.ts 의 cleanSegments 를 Rust 로 옮긴 것).

/// whisper.cpp 세그먼트 하나
pub struct Segment {
    pub t0_ms: i64,
    pub t1_ms: i64,
    pub no_speech_prob: f32,
    /// 세그먼트 토큰 평균 log 확률 — 낮을수록(음수로 클수록) 자신 없는 추정(환각 가능)
    pub avg_logprob: f32,
    pub text: String,
}

/// 무음일 확률이 이보다 크면 그 세그먼트는 버린다 (환각 억제를 위해 공격적으로)
const NO_SPEECH_DROP: f32 = 0.6;
/// 평균 log 확률이 이보다 낮으면(자신 없으면) 버린다 — 무음·잡음 위 환각은 확률이 매우 낮다
const LOGPROB_DROP: f32 = -1.0;
/// 실제 오디오 끝보다 이만큼 뒤에서 시작하는 세그먼트는 30초 패딩(무음) 위의 환각이다
const TAIL_MS: i64 = 200;

/// 무음·잡음에서 whisper 가 자주 만들어 내는 상투구
fn is_stock_phrase(text: &str) -> bool {
    const NEEDLES: &[&str] = &[
        "시청해 주셔서 감사합니다",
        "시청해주셔서 감사합니다",
        "구독과 좋아요",
        "구독 좋아요",
        "다음 영상에서",
        "다음 시간에",
        "끝까지 시청",
        "MBC 뉴스",
        "한글자막",
        "자막 제공",
        "이 영상",
        "지금까지 시청",
        "다음 영상에서 만나요",
    ];
    NEEDLES.iter().any(|n| text.contains(n) && text.chars().count() <= n.chars().count() + 6)
}

/// 디코더 루프: 같은 구절이 이어지면 한 번만 남긴다. 2자 이상 3회+, 또는 6자 이상 2회+ ("네 네" 는 둔다)
pub fn collapse_repeats(text: &str) -> String {
    let chars: Vec<char> = text.chars().collect();
    let collapse = |input: &[char], min: usize| -> Vec<char> {
        let mut out: Vec<char> = Vec::with_capacity(input.len());
        let mut i = 0;
        while i < input.len() {
            let mut folded = false;
            let max_len = ((input.len() - i) / 2).min(60);
            for len in (min..=max_len).rev() {
                if input[i..i + len] == input[i + len..i + 2 * len] {
                    let mut j = i + len;
                    while j + len <= input.len() && input[i..i + len] == input[j..j + len] {
                        j += len;
                    }
                    out.extend_from_slice(&input[i..i + len]);
                    i = j;
                    folded = true;
                    break;
                }
            }
            if !folded {
                out.push(input[i]);
                i += 1;
            }
        }
        out
    };
    let once = collapse(&chars, 6);
    let twice = collapse(&once, 2);
    twice.into_iter().collect::<String>().split_whitespace().collect::<Vec<_>>().join(" ")
}

/// 세그먼트 목록 → 조각 텍스트. 패딩 위·무음 확률 높은·상투구·직전과 같은 세그먼트를 버리고 반복을 접는다
pub fn clean_segments(segments: &[Segment], audio_ms: i64) -> String {
    let mut kept: Vec<String> = Vec::new();
    for segment in segments {
        if segment.t0_ms >= audio_ms + TAIL_MS {
            continue;
        }
        if segment.no_speech_prob > NO_SPEECH_DROP {
            continue;
        }
        if segment.avg_logprob < LOGPROB_DROP {
            continue;
        }
        let text = collapse_repeats(segment.text.trim());
        let text = text.trim();
        if text.is_empty() || is_stock_phrase(text) {
            continue;
        }
        if kept.last().map(|p| p == text).unwrap_or(false) {
            continue;
        }
        kept.push(text.to_string());
    }
    kept.join(" ")
}