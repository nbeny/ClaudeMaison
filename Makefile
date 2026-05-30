.PHONY: smoke smoke-chat download-mistral-gguf

smoke:
	@bash scripts/smoke.sh

smoke-chat:
	@bash scripts/smoke-chat.sh

# Télécharge le GGUF Mistral (~4 Go) dans le volume Docker monté par llama-cpp.
# À exécuter une fois après le premier `docker compose --profile gpu up -d`.
download-mistral-gguf:
	@bash scripts/download-mistral-gguf.sh
