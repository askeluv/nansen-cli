---
"nansen-cli": minor
---

Surface the API's request id.

Failed calls now carry `details.requestId` — the value that identifies the call end to end. Quote it when reporting a problem; previously nothing identifying a failed request ever reached the user, which made server errors effectively unreportable. Successful responses expose it alongside the credit and rate-limit figures under the `RESPONSE_META` symbol.

Absent on deployments that do not send the header yet, in which case the field is simply omitted.
