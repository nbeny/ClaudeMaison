#!/usr/bin/env bash
# Génère les stubs gRPC Python à partir de proto/tools.proto.
# Exécuter via : uv run bash scripts/gen-proto.sh
set -euo pipefail

cd "$(dirname "$0")/.."

OUT="src/tools/generated"
mkdir -p "$OUT"

python -m grpc_tools.protoc \
  -Iproto \
  --python_out="$OUT" \
  --grpc_python_out="$OUT" \
  --pyi_out="$OUT" \
  proto/tools.proto

# grpc-tools génère des imports absolus cassés ("import tools_pb2"). On les
# rend relatifs pour que le package soit utilisable tel quel.
if [[ "$(uname)" == "Darwin" ]]; then
  sed -i '' 's/^import tools_pb2/from . import tools_pb2/' "$OUT/tools_pb2_grpc.py"
else
  sed -i 's/^import tools_pb2/from . import tools_pb2/' "$OUT/tools_pb2_grpc.py"
fi

echo "Stubs générés dans $OUT"
