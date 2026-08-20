import hmac
import hashlib

from codereview_common.github.auth import verify_webhook_signature


def test_verify_webhook_signature_ok():
    secret = "testsecret"
    body = b'{"action":"opened"}'
    sig = "sha256=" + hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()
    assert verify_webhook_signature(secret, body, sig) is True


def test_verify_webhook_signature_bad():
    secret = "testsecret"
    body = b"{}"
    assert verify_webhook_signature(secret, body, "sha256=deadbeef") is False
