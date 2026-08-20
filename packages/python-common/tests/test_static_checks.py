from codereview_common.review.static_checks import run_static_checks


def test_static_checks_detects_hardcoded_secret():
    code = 'api_key = "sk-test-123"\nprint("ok")\n'
    findings = run_static_checks(code, language="python", path="app.py")
    assert any("Hardcoded credential-like value" in f.title for f in findings)


def test_static_checks_detects_bare_except():
    code = "try:\n    x = 1\nexcept:\n    pass\n"
    findings = run_static_checks(code, language="python", path="worker.py")
    assert any("Bare except clause" in f.title for f in findings)


def test_static_checks_detects_modulo_by_zero_in_prime_loop():
    code = (
        'print("hello")\n'
        "num = 17\n"
        "if num > 1:\n"
        "    for i in range(2, num):\n"
        "        if (num % 0) == 0:\n"
        '            print(num, "is not a prime number")\n'
        "            break\n"
    )
    findings = run_static_checks(code, language="python", path="x.py")
    mod = [f for f in findings if "modulo by zero" in f.title.lower() or "Division or modulo" in f.title]
    assert mod, "expected modulo-by-zero finding"
    assert mod[0].start_line == 7
    assert "num % i" in (mod[0].suggested_fix or "")
