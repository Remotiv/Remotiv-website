#!/bin/bash
# ── activate.sh ──
# Sourced automatically by pixi on shell entry / task execution.

# 1. pixi auto-injects LD_LIBRARY_PATH from [system-requirements] cuda = "12.8"
#    which pulls in system CUDA libs that conflict with torch's bundled cusparse/cublas.
#    llama-cpp-python doesn't need it — its RPATH is patched to /usr/local/cuda/lib64.
unset LD_LIBRARY_PATH

# 2. Pin nvidia-* packages so subsequent pip installs can't downgrade them 
#    and break torch. Generated once by: pip freeze | grep nvidia > constraints.txt
CONSTRAINTS="$(dirname "${BASH_SOURCE[0]}")/constraints.txt"
if [ -f "$CONSTRAINTS" ]; then
  export PIP_CONSTRAINT="$CONSTRAINTS"
fi