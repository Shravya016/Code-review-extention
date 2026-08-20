import os

import pytest
from fastapi.testclient import TestClient

from codereview_api.main import create_app


@pytest.mark.skipif(
    not os.getenv("CODEREVIEW_INTEGRATION"),
    reason="Set CODEREVIEW_INTEGRATION=1 with Postgres and Redis for /ready test",
)
def test_ready_endpoint():
    app = create_app()
    with TestClient(app) as client:
        r = client.get("/ready")
        assert r.status_code == 200
