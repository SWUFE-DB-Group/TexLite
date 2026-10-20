import { useEffect, useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { LoaderCircle } from "lucide-react";
import { COMPILER_VERSION_TOOLS, type CompilerVersionsResponse } from "../../shared/compilerVersions";
import { api } from "../api";

export function CompilerVersions() {
  const { t } = useTranslation();
  const headingId = useId();
  const [result, setResult] = useState<CompilerVersionsResponse | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    void api<CompilerVersionsResponse>("/api/compiler/versions", { signal: controller.signal })
      .then((value) => { if (!controller.signal.aborted) setResult(value); })
      .catch(() => { if (!controller.signal.aborted) setResult({ tools: [] }); });
    return () => controller.abort();
  }, []);
  const versions = new Map(result?.tools.map((tool) => [tool.id, tool.version]));
  return <section className="compiler-versions" aria-labelledby={headingId} aria-busy={result === null}>
    <h3 id={headingId}>{t("projectSettings.softwareVersions")}{result === null && <LoaderCircle size={13} className="spin" aria-label={t("common.loading")} />}</h3>
    <dl>{COMPILER_VERSION_TOOLS.map(({ id, name }) => <div key={id}>
      <dt>{name}</dt><dd className={versions.get(id) ? "" : "compiler-version-unknown"}>{result === null ? "—" : versions.get(id) ?? t("projectSettings.unknownVersion")}</dd>
    </div>)}</dl>
  </section>;
}
