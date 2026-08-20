from codereview_common.schemas import Finding, FindingCategory, Severity
from codereview_worker.main import _closest_changed_line, _extract_added_lines_from_patch


def test_extract_added_lines_from_patch():
    patch = """@@ -10,3 +10,4 @@
 line_a
 line_b
 line_c
"""
    assert _extract_added_lines_from_patch(patch) == [10, 11, 12]


def test_closest_line_picks_nearest():
    assert _closest_changed_line([12, 20, 35], 19) == 20
    assert _closest_changed_line([12, 20, 35], None) == 12


def test_finding_model_constructs_for_worker_tests():
    finding = Finding(
        id="f1",
        category=FindingCategory.SECURITY,
        severity=Severity.HIGH,
        confidence=0.8,
        title="SQL injection",
        detail="Dynamic SQL found.",
        path="src/db.py",
        start_line=20,
    )
    assert finding.path == "src/db.py"
