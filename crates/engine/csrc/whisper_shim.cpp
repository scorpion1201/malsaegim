// 말새김 whisper.cpp 브리지 — whisper.h 의 구조체 많은 API 를 Rust 가 부르기 쉬운 C 함수로 감싼다.
// 실제 전사는 whisper.cpp(멀티스레드)가 하고, 세그먼트를 모아 두면 Rust(malsaegim-engine)가 정리해 텍스트로 만든다.
// 토큰 타임스탬프로 30초 패딩(무음) 위 토큰을 잘라 내는 것은 여기서(예전 emscripten.cpp 와 동일).
#include "whisper.h"

#include <cstdio>
#include <string>
#include <vector>
#include <algorithm>

static whisper_context * g_ctx = nullptr;
static long long g_audio_ms = 0;
static const long long PAD_MARGIN_MS = 300;

struct Seg { long long t0; long long t1; float nsp; float avg_logprob; std::string text; };
static std::vector<Seg> g_segs;

static void on_progress(struct whisper_context *, struct whisper_state *, int progress, void *) {
    printf("PROG\t%d\n", progress);
    fflush(stdout);
}

static void on_segment(struct whisper_context * ctx, struct whisper_state *, int n_new, void *) {
    const int n = whisper_full_n_segments(ctx);
    const whisper_token eot = whisper_token_eot(ctx);
    for (int i = n - n_new; i < n; ++i) {
        std::string text;
        double logprob_sum = 0.0;
        int logprob_count = 0;
        const int n_tokens = whisper_full_n_tokens(ctx, i);
        for (int j = 0; j < n_tokens; ++j) {
            const whisper_token_data td = whisper_full_get_token_data(ctx, i, j);
            if (td.id >= eot) continue;
            if ((long long) td.t0 * 10 > g_audio_ms + PAD_MARGIN_MS) break;
            text += whisper_full_get_token_text(ctx, i, j);
            logprob_sum += td.plog;
            logprob_count += 1;
        }
        std::replace(text.begin(), text.end(), '\n', ' ');
        std::replace(text.begin(), text.end(), '\t', ' ');
        Seg s;
        s.t0 = (long long) whisper_full_get_segment_t0(ctx, i) * 10;
        s.t1 = (long long) whisper_full_get_segment_t1(ctx, i) * 10;
        s.nsp = whisper_full_get_segment_no_speech_prob(ctx, i);
        s.avg_logprob = logprob_count > 0 ? (float) (logprob_sum / logprob_count) : 0.0f;
        s.text = text;
        g_segs.push_back(s);
    }
}

extern "C" {

int wsh_init(const char * path) {
    if (g_ctx != nullptr) { whisper_free(g_ctx); g_ctx = nullptr; }
    whisper_context_params cparams = whisper_context_default_params();
    cparams.use_gpu = false;
    cparams.flash_attn = false; // wasm ggml-cpu flash-attn 는 멈춘다(hang) — 끈다
    g_ctx = whisper_init_from_file_with_params(path, cparams);
    return g_ctx != nullptr ? 0 : -1;
}

void wsh_free() {
    if (g_ctx != nullptr) { whisper_free(g_ctx); g_ctx = nullptr; }
}

int wsh_transcribe(const float * pcm, int n, const char * lang, int threads) {
    if (g_ctx == nullptr) return -1;
    g_segs.clear();
    g_audio_ms = (long long) n * 1000 / WHISPER_SAMPLE_RATE;
    whisper_full_params params = whisper_full_default_params(WHISPER_SAMPLING_GREEDY);
    params.print_realtime = false;
    params.print_progress = true;
    params.print_timestamps = false;
    params.print_special = false;
    params.translate = false;
    params.suppress_nst = true;
    params.suppress_blank = true;
    params.token_timestamps = true;
    params.no_context = true;        // 윈도우 간 문맥 이월 차단 — 환각이 뒤로 번지는 것 방지
    params.temperature = 0.0f;       // greedy 고정
    params.temperature_inc = 0.0f;   // 온도 폴백 끔 — 폴백(고온 샘플링)이 환각의 주범이다
    params.language = lang;
    params.n_threads = std::max(1, std::min(threads, 8));
    params.progress_callback = on_progress;
    params.new_segment_callback = on_segment;
    fprintf(stderr, "SHIM: whisper_full start n=%d thr=%d\n", n, params.n_threads); fflush(stderr);
    int rc = whisper_full(g_ctx, params, pcm, n);
    fprintf(stderr, "SHIM: whisper_full done rc=%d segs=%d\n", rc, (int) g_segs.size()); fflush(stderr);
    return rc;
}

long long wsh_audio_ms() { return g_audio_ms; }
int wsh_n_segments() { return (int) g_segs.size(); }
long long wsh_seg_t0(int i) { return g_segs[i].t0; }
long long wsh_seg_t1(int i) { return g_segs[i].t1; }
float wsh_seg_nsp(int i) { return g_segs[i].nsp; }
float wsh_seg_logprob(int i) { return g_segs[i].avg_logprob; }
const char * wsh_seg_text(int i) { return g_segs[i].text.c_str(); }

}