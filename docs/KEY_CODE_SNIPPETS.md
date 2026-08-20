# Key Code Snippets

Short, slide-ready snippets of the most important code in the project. Each box highlights one core technical piece.

---

**API Key Authentication (FastAPI):**

```python
def require_bearer(authorization: str | None = Header(default=None)) -> AuthContext:
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(401, "Missing bearer token")
    token = authorization.split(" ", 1)[1].strip()
    org = _API_KEY_MAP.get(token)
    if not org:
        raise HTTPException(401, "Invalid API key")
    return AuthContext(org_id=org)
```

---

**Static Code Checker (regex on the source):**

```python
for m in re.finditer(r"(eval\(|exec\()", content):
    findings.append(Finding(
        category="security",
        severity="high",
        title="Potential unsafe dynamic execution",
        detail="eval/exec can run untrusted input.",
        start_line=_line_no(content, m.start()),
        cwe_id="CWE-94",
        suggested_fix="Use ast.literal_eval or a safe dispatch table.",
    ))
```

---

**LLM Call (OpenAI-compatible provider):**

```python
body = {
    "model": req.model,
    "messages": [
        {"role": "system", "content": req.system},
        {"role": "user",   "content": req.user},
    ],
    "temperature": 0.2,
    "response_format": {"type": "json_object"},
}
r = await client.post(url, headers={"Authorization": f"Bearer {api_key}"}, json=body)
content = r.json()["choices"][0]["message"]["content"]
findings = json.loads(content)["findings"]
```

---

**Review Pipeline (static + LLM merge):**

```python
async def run_review(req: ReviewRequest) -> list[Finding]:
    static_findings = run_static_checks(req.content, language=req.language)
    llm_response    = await llm.complete(prompt_for(req))
    llm_findings    = parse_findings_payload(llm_response)
    merged = static_findings + filter(is_grounded, llm_findings)
    return dedupe_findings(merged)
```

---

**Deterministic Fix Template (SQL injection):**

```typescript
// q = "SELECT ... = " + user_id   →   q = "SELECT ... = ?"
const m = block.match(
  /^(\s*)(\w+\s*=\s*)(["'])(.*?(?:SELECT|INSERT|UPDATE|DELETE).*?)\3\s*\+\s*(\w+)\s*$/i
);
if (m) {
  const [, indent, lhs, quote, sqlBody, varName] = m;
  return `${indent}${lhs}${quote}${sqlBody}?${quote}  # pass (${varName},) to execute()`;
}
```

---

**Deterministic Fix Template (numeric input validation):**

```typescript
// age = input("...")  →  wrap in int(...) + try/except when 'age' is used in numeric compare
return [
  `${indent}try:`,
  `${indent}    ${varName} = int(input(${promptArg}))`,
  `${indent}except ValueError:`,
  `${indent}    raise ValueError("Invalid input for ${varName}; expected an integer.")`,
].join("\n");
```

---

**VS Code Quick-Fix Lightbulb (Code Action):**

```typescript
const apply = new vscode.CodeAction(
  `CodeReview: Apply fix - ${title}`,
  vscode.CodeActionKind.QuickFix,
);
apply.command = {
  command: "codereview.acceptFindingFix",
  title:   "Apply fix",
  arguments: [doc.uri.toString(), findingIndex],
};
apply.isPreferred = true;
return [apply, generate, reject];
```

---

**Diff Preview Before Writing:**

```typescript
const proposed = renderEditsPreviewText(doc.getText(), edits);
const previewDoc = await vscode.workspace.openTextDocument({
  language: doc.languageId,
  content:  proposed,
});
await vscode.commands.executeCommand("vscode.diff", doc.uri, previewDoc.uri,
  `CodeReview Preview: ${fileName}`);

const choice = await vscode.window.showWarningMessage(
  `Apply ${edits.length} proposed fix(es)?`,
  { modal: true }, "Apply", "Cancel",
);
if (choice !== "Apply") return false;
await vscode.workspace.applyEdit(wsEdit);
```

---

**GitHub Webhook Signature Verification (HMAC-SHA256):**

```python
def verify_webhook_signature(secret: str, body: bytes, signature_header: str | None) -> bool:
    if not signature_header or not signature_header.startswith("sha256="):
        return False
    digest = signature_header.removeprefix("sha256=")
    mac    = hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()
    return hmac.compare_digest(mac, digest)
```

---

**Async Worker - PR Review Loop:**

```python
while True:
    job = await dequeue_job(redis, "pr_reviews")
    token = await get_installation_token(job.installation_id)
    files = await fetch_pr_files(token, job.repo, job.pr_number)
    for f in files:
        findings = await run_review(ReviewRequest(content=f.patch, language=f.lang))
        await post_inline_comments(token, job, f, findings)
    await create_check_run(token, job, summary_for(files))
```
