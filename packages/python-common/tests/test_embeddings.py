from codereview_common.rag.embeddings import ollama_native_base, resolve_embedding_settings


def test_ollama_native_base_strips_v1():
    assert ollama_native_base("http://127.0.0.1:11434/v1") == "http://127.0.0.1:11434"


def test_resolve_ollama_without_openai():
    s = resolve_embedding_settings(
        embedding_provider="ollama",
        openai_api_key=None,
        ollama_base_url="http://127.0.0.1:11434/v1",
        embedding_model=None,
        embedding_dimension=None,
    )
    assert s is not None
    assert s.provider == "ollama"
    assert s.model == "nomic-embed-text"
    assert s.dimension == 768
