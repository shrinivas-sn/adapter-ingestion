# RFC: Generic Ingestion Extensions (v0.3.0 Proposal)

**Package:** `@shrinivas-sn/adapter-ingestion`  
**Current Baseline:** `v0.2.0` (commit `face358`, published to npm, 281 test suite pass)  
**Status:** Draft / Architectural Handover for Future AI Maintainers  

---

## 1. Context & Motivation

During integration testing of various public web APIs (such as key-value structured feeds and identifier-based feeds), two generic engine limitations were observed in `v0.2.0`:

1. **Object-Structured Endpoints:** Endpoints that return JSON records inside keyed objects (e.g. `{"records": {"id_1": {...}, "id_2": {...}}}`) fail schema extraction because `records_path` strictly expects a top-level `Array`.
2. **URL Construction from IDs:** The core contract (`contract.mjs`) mandates a valid HTTP/HTTPS `url` on every record. APIs that return raw identifiers (e.g., `item_id`, `station_code`, `cve`, `ip`) without a full URL field cannot be ingested without a templating mechanism.

---

## 2. Identified Engine Gaps in `v0.2.0`

### Gap A: Strict Array Assertion in `records_path`
* **Location:** [`src/fetch.mjs:218-223`](file:///E:/adapter-ingestion/src/fetch.mjs#L218-L223)
* **Code:**
  ```javascript
  const batch = getPath(body, adapter.records_path ?? '$') ?? [];
  if (!Array.isArray(batch)) {
    throw new IngestionError('E_RESPONSE_SHAPE', `records_path "${adapter.records_path ?? '$'}" resolved to ${typeof batch}, expected an array`);
  }
  ```
* **Limitation:** Incompatible with APIs that index records by dictionary keys rather than a flat array.

---

### Gap B: Lack of String Interpolation in Field Mapping
* **Location:** [`src/extract.mjs:79-84`](file:///E:/adapter-ingestion/src/extract.mjs#L79-L84)
* **Code:**
  ```javascript
  for (const [name, rule] of Object.entries(adapter.map)) {
    const raw = getPath(item, rule.path);
    const value = rule.normalize ? applyNormalizer(rule.normalize, raw) : (raw ?? null);
    fields[name] = value === undefined ? null : value;
  }
  ```
* **Limitation:** `map` only reads existing paths. It cannot synthesize deep-link URLs (e.g., `https://service.example.org/item/{id}`) from extracted item properties.

---

## 3. Generic Architectural Solutions (Zero Hardcoding)

Both additions must adhere to the library's design principles: deterministic, safe, protocol-level transforms without domain-specific logic.

### Solution A: Dictionary / Object Traversal in `fetch.mjs`
Support extracting records from object dictionaries by flattening `Object.values(batch)` when declared or using wildcard syntax:

1. **Adapter Declaration (`adapters/<host>.adapter.json`):**
   ```json
   {
     "records_path": "items",
     "records_shape": "object_values"
   }
   ```
   *(Or alternatively supporting wildcard path syntax: `"records_path": "items.*"`)*

2. **Engine Implementation (`src/fetch.mjs`):**
   ```javascript
   let batch = getPath(body, adapter.records_path ?? '$') ?? [];
   if (!Array.isArray(batch) && batch !== null && typeof batch === 'object') {
     if (adapter.records_shape === 'object_values' || adapter.records_path?.endsWith('.*')) {
       batch = Object.values(batch).flat();
     }
   }
   if (!Array.isArray(batch)) {
     throw new IngestionError('E_RESPONSE_SHAPE', ...);
   }
   ```

---

### Solution B: Safe String Templating in `extract.mjs`
Allow declarative string interpolation under `adapter.map`:

1. **Adapter Declaration (`adapters/<host>.adapter.json`):**
   ```json
   "map": {
     "source_id": { "path": "entry_id" },
     "url": {
       "template": "https://api.example.com/view/{source_id}",
       "vars": { "source_id": "entry_id" }
     }
   }
   ```

2. **Engine Implementation (`src/extract.mjs`):**
   ```javascript
   if (rule.template) {
     let rendered = rule.template;
     for (const [varName, varPath] of Object.entries(rule.vars ?? {})) {
       const rawVal = getPath(item, varPath);
       rendered = rendered.replaceAll(`{${varName}}`, encodeURIComponent(String(rawVal ?? '')));
     }
     fields[name] = rendered;
   } else {
     const raw = getPath(item, rule.path);
     fields[name] = rule.normalize ? applyNormalizer(rule.normalize, raw) : (raw ?? null);
   }
   ```

3. **Security & Validation:**
   * Enforce `encodeURIComponent` to prevent header/URI injection.
   * Validate in `src/adapter.mjs` that every token `{token}` inside `template` has a corresponding mapping in `rule.vars`.

---

## 4. Work Checklist for Future Maintainer / AI Agent

When implementing `v0.3.0`:

- [ ] **1. Schema Updates (`src/adapter.mjs` & `src/config.mjs`)**
  - Add validation rules for `template`, `vars`, and `records_shape`.
- [ ] **2. Core Engine Updates**
  - Update `src/fetch.mjs` for object payload extraction.
  - Update `src/extract.mjs` for template rendering.
- [ ] **3. Unit & Integration Tests**
  - Add test fixtures in `test/extract.test.mjs` and `test/fetch.test.mjs`.
  - Verify all 281 existing tests pass with 0 regressions.
- [ ] **4. Commit & Release**
  - Commit pending adapter additions (`adapters/api.github.com.adapter.json`, fixtures, verify scripts).
  - Use Changeset to bump version to `0.3.0`.
