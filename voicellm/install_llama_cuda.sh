#!/bin/bash
# ── install_llama_cuda.sh ──
# Rebuild llama-cpp-python from source with CUDA, RPATH-patched to the system
# CUDA install rather than left to LD_LIBRARY_PATH. Shared by this repo's own
# pixi.toml (`pixi run install-llama`) and by rtr_module's, which vendors this
# script by path instead of copying the build — the two projects have separate
# pixi environments (separate site-packages), so this must be re-run once per
# environment, but the logic itself has exactly one copy.
#
# The PyPI wheel is CPU-only; CUDA requires building from source (see this
# repo's README, "Installing as a package"). Run from inside the target pixi
# env (`pixi run install-llama` in either repo) so `python`/`pip`/`patchelf`
# on PATH are that environment's.
set -euo pipefail

CUDA_ROOT="${CUDA_ROOT:-/usr/local/cuda}"

# Auto-detect this host's GPU compute capability unless the caller pins one —
# hardcoding it is what caused rtr_module (an L4, 8.9) to inherit this repo's
# A10 value (8.6) and silently build for the wrong architecture.
if [ -z "${CMAKE_CUDA_ARCHITECTURES:-}" ]; then
  CMAKE_CUDA_ARCHITECTURES="$(nvidia-smi --query-gpu=compute_cap --format=csv,noheader \
    | head -1 | tr -d '. ')"
  if [ -z "$CMAKE_CUDA_ARCHITECTURES" ]; then
    echo "Could not detect a GPU via nvidia-smi; set CMAKE_CUDA_ARCHITECTURES explicitly." >&2
    exit 1
  fi
fi
echo "Building llama-cpp-python for CMAKE_CUDA_ARCHITECTURES=$CMAKE_CUDA_ARCHITECTURES"

export CUDA_HOME="$CUDA_ROOT"
export CUDA_PATH="$CUDA_ROOT"
export CUDACXX="$CUDA_ROOT/bin/nvcc"
export CUDA_TOOLKIT_ROOT_DIR="$CUDA_ROOT"
export PATH="$CUDA_ROOT/bin:$PATH"
export LD_LIBRARY_PATH="$CUDA_ROOT/lib64:${LD_LIBRARY_PATH:-}"
export CMAKE_ARGS="-DGGML_CUDA=on -DCMAKE_CUDA_ARCHITECTURES=$CMAKE_CUDA_ARCHITECTURES -DCUDAToolkit_ROOT=$CUDA_ROOT -DCUDA_TOOLKIT_ROOT_DIR=$CUDA_ROOT"
export CMAKE_BUILD_PARALLEL_LEVEL=4

pip install llama-cpp-python==0.3.30 --force-reinstall --no-cache-dir --no-binary llama-cpp-python

LLAMA_LIB="$(python -c "import site; print(site.getsitepackages()[0])")/llama_cpp/lib/libggml-cuda.so.0"
patchelf --set-rpath "$CUDA_ROOT/lib64" "$LLAMA_LIB"
echo "RPATH patched: $(patchelf --print-rpath "$LLAMA_LIB")"
echo "cublas link: $(ldd "$LLAMA_LIB" | grep cublas)"
