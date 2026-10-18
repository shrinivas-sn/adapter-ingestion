import { decodeJson } from '../http.mjs';

// The original and default kind: UTF-8 JSON, decoded exactly as readJsonBody
// always has (empty body -> null, anything unparseable -> E_RESPONSE_JSON).
export const jsonKind = Object.freeze({
  name: 'json-api',
  validate() {},
  parse({ bytes }) {
    return decodeJson(bytes);
  },
});
