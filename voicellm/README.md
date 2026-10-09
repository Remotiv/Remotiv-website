# VoxAgent

Real-time AI voice agent — Gemma 4 E4B (Q4_1) for language, Kokoro-82M for TTS, with sub-300ms first-audio latency on a single A10G GPU.

Config-driven — swap models, TTS engines, or personas without touching pipeline code.

---

## Part 1: Setup & Running

### 1.1 Install Pixi

```bash
curl -fsSL https://pixi.sh/install.sh | bash
```

Restart your shell or run:

```bash
source ~/.bashrc
```

Verify:

```bash
pixi --version
```

### 1.2 Clone & Install Environment

```bash
git clone https://github.com/remotiv/voxagent.git
cd voxagent

# Install conda dependencies
pixi install

# Install all pip packages (Kokoro, llama-cpp-python with CUDA, etc.)
pixi run setup
```


### 1.3 Download Model Weights

VoxAgent needs two model files: the Gemma 4 E4B language model (GGUF quantized) and its multimodal projector (for audio input).


#### From S3

```bash
aws s3 cp s3://remotiv-research-test/research_team/models/agentic_model_weights/gemma-4-E4B-it-Q4_1.gguf model_pth/
aws s3 cp s3://remotiv-research-test/research_team/models/agentic_model_weights/mmproj-BF16.gguf model_pth/
```

#### Update paths

After downloading, edit `configs/models/gemma4_e4b.yaml` to point at your files:

```yaml
model:
  path: "models/gemma-4-E4B-it-Q4_1.gguf"

audio:
  mmproj_path: "models/mmproj-gemma-4-E4B-it-bf16.gguf"
  warmup_wav: "audios/test_question.wav"      # any short WAV for warmup
```



### 1.4 Running

#### Pass a document directly — no YAML needed

```bash
python main.py --persona-config docs/fifa.txt
```

VoxAgent sees `.txt`, auto-generates a persona with sensible defaults (voice, output style, generation params), and loads the document as context. Works with `.md` files too.

#### Interactive mode

```bash
python main.py --persona-config docs/fifa.txt
```

```
> What year did Germany win the World Cup?        # text input
> /audio audios/question_01.wav                   # audio input
> /quit                                           # exit
```

#### Document + audio evaluation

Run a batch of audio questions against a document:

```bash
python main.py \
    --persona-config docs/fifa.txt \
    --questions audios/fifa/
```

Processes every `.wav` in order, saves per-question audio chunks and a JSON report:

```
reports/
└── fifa/
    ├── fifa.json                  # timing report (prefill, TTFT, TPS, first-audio)
    ├── q01_question1_chunk00.wav  # TTS audio responses
    ├── q01_question1_chunk01.wav
    └── ...
```

#### Text-only mode

Skips loading the audio encoder — saves ~600 MB VRAM:

```bash
python main.py --text-only --persona-config docs/fifa.txt
```

#### Using YAML personas (full control)

For custom system prompts, specific voices, or multiple knowledge documents:

```yaml
# configs/personas/cricket_expert.yaml
name: "Cricket Expert"

system_prompt: |
  You are a cricket analyst specializing in ICC World Cup history.
  Be precise with match scores, player stats, and tournament brackets.

knowledge:
  - path: "corpora/cricket_wc.txt"
    strategy: prefix_cache

tts:
  voice: "am_michael"
```

Any field you omit inherits from the defaults in `config_loader.py`. Run it:

```bash
python main.py --persona-config configs/personas/cricket_expert.yaml
```

#### CLI reference

| Flag | Default | Description |
|---|---|---|
| `--persona-config` | `configs/personas/default.yaml` | Persona YAML **or** `.txt`/`.md` document |
| `--model-config` | `configs/models/gemma4_e4b.yaml` | LLM backend config |
| `--tts-config` | `configs/tts/kokoro.yaml` | TTS engine config |
| `--questions` | — | Directory of `.wav` files (enables eval mode) |
| `--text-only` | off | Disable audio input |
| `--output` | auto-generated | Output directory for audio and reports |

### 1.5 Troubleshooting

**`torch` import fails with cusparse/cublas errors:**

```bash
pixi run fix-nvidia
```


---

## Part 2: Extending VoxAgent

### Project Structure

```
voxagent/
├── main.py                              # Entry point
├── configs/
│   ├── models/
│   │   └── gemma4_e4b.yaml              # LLM config
│   ├── personas/
│   │   ├── default.yaml                 # Inherits all defaults
│   │   └── fifa_expert.yaml             # Document-backed persona
│   └── tts/
│       └── kokoro.yaml                  # TTS engine config
├── voxagent/
│   ├── config_loader.py                 # YAML loading + PERSONA_DEFAULTS
│   ├── pipeline.py                      # Generic ask_audio / ask_text loop
│   ├── backends/
│   │   ├── __init__.py                  # Factory registry
│   │   ├── base.py                      # LLMBackend / TTSBackend ABCs
│   │   ├── gemma4/
│   │   │   └── backend.py
│   │   └── kokoro/
│   │       ├── backend.py
│   │       ├── _patched_forward.py
│   │       └── text_utils.py
│   └── utils/
│       └── helpers.py
```

`pipeline.py` only imports from `base.py`. It never knows which LLM or TTS it's talking to. Concrete backends are resolved at runtime by the factory.

### Adding a New LLM Backend

Three steps. Nothing else changes.

**Step 1 — Config**

```yaml
# configs/models/llama4_scout.yaml
backend: llama4

model:
  path: "/data/models/llama4-scout-Q4.gguf"
  context_size: 65536
  n_gpu_layers: -1
  flash_attn: true
  verbose: false

audio:
  enabled: true
  mmproj_path: "/data/models/llama4-scout-mmproj.gguf"
  warmup_wav: "audios/test.wav"

generation:
  max_tokens: 2048
  soft_limit: 1800

chat_template:
  system_prefix: "<|begin_of_text|><|start_header_id|>system<|end_header_id|>\n\n"
  system_suffix: "<|eot_id|><|start_header_id|>user<|end_header_id|>\n\n"
  post_user: "<|eot_id|><|start_header_id|>assistant<|end_header_id|>\n\n"
```

`chat_template` is what makes models swappable — each model uses different turn markers, and they live in config not code.

**Step 2 — Implement**

Create `voxagent/backends/llama4/backend.py` implementing `LLMBackend`:

```python
from voxagent.backends.base import LLMBackend, TokenEvent, EvalDetail

class Llama4Backend(LLMBackend):
    def __init__(self, model_config: dict):    # Load model, read config
    def setup_persona(self, persona_config):   # Build prompt, tokenize, eval prefix
    def warmup(self, warmup_wav_path=None):    # CUDA warmup passes
    def trim_to_persona(self):                 # KV cache → persona boundary
    def eval_audio(self, wav_bytes) -> EvalDetail:  # Audio encode + eval
    def eval_text(self, user_text) -> EvalDetail:   # Text tokenize + eval
    def eval_post_input(self) -> float:        # Post-input turn markers
    def generate(self):                        # Yield TokenEvent stream
    def interrupt(self):                       # Barge-in flag
    def n_persona_tokens(self) -> int:         # Property
    def supports_audio(self) -> bool:          # Property
    def close(self):                           # Cleanup
```

Add `voxagent/backends/llama4/__init__.py`:

```python
from voxagent.backends.llama4.backend import Llama4Backend
__all__ = ["Llama4Backend"]
```

**Step 3 — Register**

One line in `voxagent/backends/__init__.py`:

```python
_LLM_BACKENDS = {
    "gemma4": "voxagent.backends.gemma4.backend:Gemma4Backend",
    "llama4": "voxagent.backends.llama4.backend:Llama4Backend",
}
```

Import is lazy — `llama4` code only loads when the config requests it. Run:

```bash
python main.py --model-config configs/models/llama4_scout.yaml --persona-config docs/fifa.txt
```

### Adding a New TTS Backend

Same three steps with `TTSBackend` ABC.

**Step 1 — Config**

```yaml
# configs/tts/xtts.yaml
backend: xtts
device: "cuda"
sample_rate: 22050
model_path: "/data/models/xtts_v2"
```

**Step 2 — Implement** `voxagent/backends/xtts/backend.py`:

```python
from voxagent.backends.base import TTSBackend, TTSMetrics

class XTTSBackend(TTSBackend):
    def __init__(self, tts_config, persona_config):  # Engine + voice from persona
    def sample_rate(self) -> int:                     # Property
    def begin_question(self):                         # Reset state, start timer
    def submit(self, text, chunk_idx):                # Queue for synthesis
    def wait_first_chunk(self, timeout=2.0):          # Block until chunk 0 ready
    def finish_question(self, base_path=None) -> TTSMetrics:  # Collect + return
    def warmup(self):
    def close(self):
```

**Step 3 — Register**

```python
_TTS_BACKENDS = {
    "kokoro": "voxagent.backends.kokoro.backend:KokoroTTSBackend",
    "xtts":   "voxagent.backends.xtts.backend:XTTSBackend",
}
```

### Changing Voice per Persona

Voice is persona-specific, not engine-specific. Different personas can use different voices on the same TTS engine:

```yaml
# configs/personas/male_narrator.yaml
tts:
  voice: "am_michael"
```

```yaml
# configs/personas/female_assistant.yaml
tts:
  voice: "af_heart"
```



### Testing Changes

**Smoke test (fastest — text only, no audio encoder):**

```bash
python main.py --text-only --persona-config docs/fifa.txt
> Who won the 2014 World Cup?
```

**Audio test — single question:**

```bash
python main.py --persona-config docs/fifa.txt
> /audio audios/test_question.wav
```

**Full eval — compare against baseline:**

```bash
python main.py \
    --persona-config docs/fifa.txt \
    --questions audios/fifa/ \
    --output reports/test_run

cat reports/test_run/fifa.json | python -m json.tool | head -20
```

Compare `avg_first_audio_latency_ms` and `avg_pipeline_ms` against your baseline.

**Testing a new backend — progressive:**

```bash
# 1. Text-only (catches loading/config issues)
python main.py --model-config configs/models/newmodel.yaml --text-only

# 2. Audio
python main.py --model-config configs/models/newmodel.yaml --persona-config docs/fifa.txt

# 3. Full eval comparison
python main.py \
    --model-config configs/models/newmodel.yaml \
    --persona-config docs/fifa.txt \
    --questions audios/fifa/ \
    --output reports/newmodel_eval
```

### Config Cheat Sheet

**Model config** (`configs/models/*.yaml`):

| Field | When to change |
|---|---|
| `model.path` | Different model file |
| `model.context_size` | Model supports larger/smaller context |
| `audio.enabled` | Model does/doesn't support audio input |
| `audio.mmproj_path` | Different multimodal projector |
| `generation.max_tokens` | Longer/shorter answers |
| `generation.soft_limit` | When to start looking for sentence end |
| `chat_template.*` | Every model has different turn markers |

**Persona config** (`configs/personas/*.yaml` or `.txt` file):

| Field | When to change |
|---|---|
| `system_prompt` | Different personality or expertise |
| `output_instructions` | Different answer length/format |
| `knowledge[].path` | Different document |
| `knowledge[].strategy` | `prefix_cache` now, `rag` later |
| `tts.voice` | Different voice |

**TTS config** (`configs/tts/*.yaml`):

| Field | When to change |
|---|---|
| `chunking.first_chunk_chars` | Trade first-audio latency vs chunk quality |
| `decoder_buckets` | If Kokoro hits novel shapes (check logs) |
| `stream_priority` | CUDA stream priority for first chunk |



### Installing VoxAgent as a Package in Other Repos

VoxAgent is a pip package (`pyproject.toml`) with two dependency tiers:

- **Core** (`pyyaml`, `loguru`) — always installed, lets you import `voxagent.config_loader` / `voxagent.pipeline` / `voxagent.backends` and use the registry without pulling in any GPU stack.
- **`gpu` extra** — Gemma 4 + Kokoro backends: `torch`, `torchaudio`, `llama-cpp-python`, `kokoro`, `misaki`, `pykokoro`, `phonemizer-fork`, `espeakng-loader`, `numpy`, `soundfile`.

```bash
pip install "voxagent[gpu] @ git+https://github.com/remotiv/voxagent.git"
```

The `gpu` extra requires Python 3.10–3.12 (`kokoro==0.9.4` doesn't support 3.13+ yet — matches the `python = "3.11.*"` pin in [pixi.toml](pixi.toml)). This gets you a CPU-only `llama-cpp-python` build. For CUDA acceleration, rebuild it from source afterwards, RPATH-patched to your system CUDA install (this is what `pixi run install-llama` in [pixi.toml](pixi.toml) automates for the pixi-managed environment):

```bash
export CUDA_HOME=/usr/local/cuda
export CUDA_PATH=/usr/local/cuda
export CUDACXX=/usr/local/cuda/bin/nvcc
export CUDA_TOOLKIT_ROOT_DIR=/usr/local/cuda
export PATH=/usr/local/cuda/bin:$PATH
export LD_LIBRARY_PATH=/usr/local/cuda/lib64:$LD_LIBRARY_PATH
export CMAKE_ARGS="-DGGML_CUDA=on -DCMAKE_CUDA_ARCHITECTURES=86 -DCUDAToolkit_ROOT=/usr/local/cuda -DCUDA_TOOLKIT_ROOT_DIR=/usr/local/cuda"
export CMAKE_BUILD_PARALLEL_LEVEL=4

pip install llama-cpp-python==0.3.30 --force-reinstall --no-cache-dir --no-binary llama-cpp-python
LLAMA_LIB=$(python -c "import site; print(site.getsitepackages()[0])")/llama_cpp/lib/libggml-cuda.so.0
patchelf --set-rpath /usr/local/cuda/lib64 "$LLAMA_LIB"
```

Once installed, the `voxagent` command is on your `PATH` (equivalent to `python main.py` in this repo — see [voxagent/cli.py](voxagent/cli.py)). It looks for `configs/models`, `configs/personas`, `configs/tts` under your **current working directory**, so run it from a project directory that has its own `configs/` folder (copy the examples from this repo's [configs/](configs/) to get started), or pass `--model-config` / `--persona-config` / `--tts-config` explicitly:

```bash
voxagent --persona-config docs/fifa.txt
```