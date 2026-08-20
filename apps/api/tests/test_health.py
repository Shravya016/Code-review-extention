from fastapi.testclient import TestClient

from codereview_api.main import create_app


def test_health_endpoint():
    app = create_app()
    with TestClient(app) as client:
        r = client.get("/health")
        assert r.status_code == 200
        assert r.json() == {"status": "ok"}
