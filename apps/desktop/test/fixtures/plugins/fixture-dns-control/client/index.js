// S9's DNS-prefetch probe for the app's tests: a layer asks Chromium to look up a host name of its own. With the
// layer's `Connection-Allowlist` the lookup never reaches the resolver; the positive control (the same document served
// without its allowlist, `fixture-dns-control`) shows the probe would see one.
import { jsx } from "react/jsx-runtime";
import { useEffect, useState } from "react";

export function DnsProbe() {
  const [name, setName] = useState("");
  useEffect(() => {
    const host = `${location.host}-probe.example`;
    const link = document.createElement("link");
    link.rel = "dns-prefetch";
    link.href = `//${host}`;
    document.head.append(link);
    setName(host);
  }, []);
  return jsx("div", { "data-fixture": "dns", children: name === "" ? "" : `probe: ${name}` });
}
