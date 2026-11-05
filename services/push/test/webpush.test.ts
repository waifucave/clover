// Web Push encryption against RFC 8291's worked example, and which push services an endpoint may name.

import { describe, expect, it } from "vitest";

import { b64u, fromB64u, utf8 } from "../../shared/encoding";
import { importRawP256 } from "../src/es256";
import { allowedEndpoint, encryptPayload } from "../src/webpush";

// RFC 8291, Section 5 and Appendix A.
const RFC = {
  plaintext: "When I grow up, I want to be a watermelon",
  asPublic: "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8",
  asPrivate: "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw",
  uaPublic: "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
  salt: "DGv6ra1nlYgDCS1FRnbzlw",
  authSecret: "BTBZMqHH6r4Tts7J_aSIgg",
  body:
    "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27ml" +
    "mlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPT" +
    "pK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN",
};

describe("RFC 8291 encryption", () => {
  it("produces the RFC's message body from its keys and salt", async () => {
    const asPublic = fromB64u(RFC.asPublic);
    const seed = { privateKey: await importRawP256(asPublic, fromB64u(RFC.asPrivate), "deriveBits"), publicKey: asPublic, salt: fromB64u(RFC.salt) };
    const body = await encryptPayload(utf8(RFC.plaintext), fromB64u(RFC.uaPublic), fromB64u(RFC.authSecret), seed);
    expect(b64u(body)).toBe(RFC.body);
  });

  it("uses a fresh key and salt for every message", async () => {
    const a = await encryptPayload(utf8("x"), fromB64u(RFC.uaPublic), fromB64u(RFC.authSecret));
    const b = await encryptPayload(utf8("x"), fromB64u(RFC.uaPublic), fromB64u(RFC.authSecret));
    expect(b64u(a.subarray(0, 16))).not.toBe(b64u(b.subarray(0, 16)));
    expect(b64u(a.subarray(21, 86))).not.toBe(b64u(b.subarray(21, 86)));
  });
});

describe("push service endpoints", () => {
  const hosts = "fcm.googleapis.com,updates.push.services.mozilla.com,web.push.apple.com,*.notify.windows.com";

  it("allows the browsers' push services", () => {
    for (const endpoint of [
      "https://fcm.googleapis.com/fcm/send/abc",
      "https://updates.push.services.mozilla.com/wpush/v2/abc",
      "https://web.push.apple.com/QAbc",
      "https://wns2-par02p.notify.windows.com/w/?token=abc",
    ]) {
      expect(allowedEndpoint(endpoint, hosts)).toBe(true);
    }
  });

  it("refuses anything else, so a subscription cannot point the service at another host", () => {
    for (const endpoint of [
      "http://fcm.googleapis.com/fcm/send/abc",
      "https://fcm.googleapis.com:8443/fcm/send/abc",
      "https://user:pass@fcm.googleapis.com/fcm/send/abc",
      "https://evil.example/fcm.googleapis.com",
      "https://fcm.googleapis.com.evil.example/x",
      "https://notify.windows.com/x",
      "https://169.254.169.254/latest/meta-data",
      `https://fcm.googleapis.com/${"a".repeat(1100)}`,
      "not a url",
    ]) {
      expect(allowedEndpoint(endpoint, hosts)).toBe(false);
    }
  });
});
