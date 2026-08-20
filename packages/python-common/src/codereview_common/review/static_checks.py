from __future__ import annotations

import re
import uuid

from codereview_common.schemas import Finding, FindingCategory, Severity


def _mk_finding(
    *,
    category: FindingCategory,
    severity: Severity,
    title: str,
    detail: str,
    path: str | None,
    line: int | None,
    cwe_id: str | None = None,
    owasp: str | None = None,
    suggested_fix: str | None = None,
    references: list[str] | None = None,
) -> Finding:
    return Finding(
        id=str(uuid.uuid4()),
        category=category,
        severity=severity,
        confidence=0.9,
        title=title,
        detail=detail,
        cwe_id=cwe_id,
        owasp=owasp,
        path=path,
        start_line=line,
        end_line=line,
        suggested_fix=suggested_fix,
        references=references or [],
    )


def _line_no(content: str, idx: int) -> int:
    return content.count("\n", 0, idx) + 1


def run_static_checks(content: str, *, language: str = "plaintext", path: str | None = None) -> list[Finding]:
    findings: list[Finding] = []
    lower_lang = (language or "").lower()

    for m in re.finditer(r"(eval\(|exec\()", content):
        findings.append(
            _mk_finding(
                category=FindingCategory.SECURITY,
                severity=Severity.HIGH,
                title="Potential unsafe dynamic execution",
                detail="Using eval/exec can execute untrusted input and lead to remote code execution.",
                path=path,
                line=_line_no(content, m.start()),
                cwe_id="CWE-94",
                owasp="A03:2021-Injection",
                suggested_fix="Replace eval/exec with explicit parsing or a safe allowlisted dispatch table.",
                references=["https://cwe.mitre.org/data/definitions/94.html"],
            )
        )

    for m in re.finditer(r"(password|token|secret|api[_-]?key)\s*=\s*['\"][^'\"]+['\"]", content, re.I):
        findings.append(
            _mk_finding(
                category=FindingCategory.SECURITY,
                severity=Severity.HIGH,
                title="Hardcoded credential-like value",
                detail="A literal secret-like assignment was detected. Move credentials to a secret manager or env var.",
                path=path,
                line=_line_no(content, m.start()),
                cwe_id="CWE-798",
                owasp="A07:2021-Identification and Authentication Failures",
                suggested_fix="Read secret from environment variables and rotate any exposed credentials.",
                references=["https://cwe.mitre.org/data/definitions/798.html"],
            )
        )

    for m in re.finditer(r"(SELECT|INSERT|UPDATE|DELETE).+(\+|%s|\.format\(|f\")", content, re.I):
        findings.append(
            _mk_finding(
                category=FindingCategory.SECURITY,
                severity=Severity.HIGH,
                title="Possible SQL injection via dynamic query construction",
                detail="SQL statement appears to be assembled dynamically. Use parameterized queries.",
                path=path,
                line=_line_no(content, m.start()),
                cwe_id="CWE-89",
                owasp="A03:2021-Injection",
                suggested_fix="Use bind parameters (e.g. SQLAlchemy text(..., bindparams=...)) instead of string concatenation.",
                references=["https://cwe.mitre.org/data/definitions/89.html"],
            )
        )

    if lower_lang in {"python", "py"}:
        lines = content.splitlines()
        for line_no, line in enumerate(lines, start=1):
            if re.search(r"%\s*0\b", line) or re.search(r"/\s*0\b", line):
                loop_var = "i"
                for prev in reversed(lines[: line_no - 1]):
                    fm = re.search(r"for\s+(\w+)\s+in\s+range", prev)
                    if fm:
                        loop_var = fm.group(1)
                        break
                fixed_line = re.sub(r"%\s*0\b", f"% {loop_var}", line)
                detail = (
                    "Modulo or division by zero raises ZeroDivisionError at runtime. "
                    f"In a loop over `{loop_var}`, the remainder check should use `{loop_var}`, not `0`."
                )
                findings.append(
                    _mk_finding(
                        category=FindingCategory.BUG,
                        severity=Severity.CRITICAL,
                        title="Division or modulo by zero",
                        detail=detail,
                        path=path,
                        line=line_no,
                        cwe_id="CWE-369",
                        suggested_fix=fixed_line.strip(),
                    )
                )

        for m in re.finditer(r"\bexcept\s*:\s*", content):
            findings.append(
                _mk_finding(
                    category=FindingCategory.QUALITY,
                    severity=Severity.MEDIUM,
                    title="Bare except clause",
                    detail="Bare except hides unexpected failures and makes debugging difficult.",
                    path=path,
                    line=_line_no(content, m.start()),
                    suggested_fix="Catch specific exceptions (e.g. `except ValueError:`) and log context.",
                )
            )

    if lower_lang in {"javascript", "typescript", "js", "ts", "tsx", "jsx"}:
        for m in re.finditer(r"\b(var)\b", content):
            findings.append(
                _mk_finding(
                    category=FindingCategory.MAINTAINABILITY,
                    severity=Severity.LOW,
                    title="Use let/const instead of var",
                    detail="`var` has function scope and can cause subtle hoisting bugs.",
                    path=path,
                    line=_line_no(content, m.start()),
                    suggested_fix="Prefer `const` by default and `let` when reassignment is needed.",
                )
            )

    long_lines = [i + 1 for i, line in enumerate(content.splitlines()) if len(line) > 140]
    if len(long_lines) >= 3:
        findings.append(
            _mk_finding(
                category=FindingCategory.QUALITY,
                severity=Severity.LOW,
                title="Multiple overly long lines",
                detail="Long lines reduce readability and usually indicate missing abstractions.",
                path=path,
                line=long_lines[0],
                suggested_fix="Wrap long statements and extract helper functions to keep line length consistent.",
            )
        )

    return findings
