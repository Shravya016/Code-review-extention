from codereview_common.rag.redaction import content_hash, fingerprint_finding, redact_for_embedding


def test_redact_pem():
    text = "x\n-----BEGIN RSA PRIVATE KEY-----\nABC\n-----END RSA PRIVATE KEY-----\ny"
    out = redact_for_embedding(text)
    assert "BEGIN RSA" not in out
    assert "[REDACTED_PEM]" in out


def test_fingerprint_stable():
    a = fingerprint_finding("p.py", 10, "SQL injection")
    b = fingerprint_finding("p.py", 10, "SQL injection")
    assert a == b
    assert len(content_hash("hi")) == 64
