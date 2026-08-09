import { lazy, Suspense, useEffect, useState, useRef, useCallback } from "react";
import { api } from "@/lib/api";
import type { Employee, OrgData, OrgHierarchy } from "@/lib/api";
import { EmployeeDetail } from "@/components/org/employee-detail";
import { PageLayout } from "@/components/page-layout";
import { useSettings } from "@/routes/settings-provider";
import { useBreadcrumbs } from "@/context/breadcrumb-context";

const OrgMap = lazy(() =>
  import("@/components/org/org-map").then((m) => ({ default: m.OrgMap })),
);

const OrgMapFallback = (
  <div className="flex flex-col items-center justify-center h-full gap-[var(--space-3)] text-[var(--text-tertiary)] text-[length:var(--text-caption1)]">
    Loading map...
  </div>
);

export default function OrgPage() {
  useBreadcrumbs([{ label: 'Organization' }])
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [hierarchy, setHierarchy] = useState<OrgHierarchy | undefined>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Employee | null>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const { settings } = useSettings();

  const loadData = useCallback(() => {
    setLoading(true);
    setError(null);
    api
      .getOrg()
      .then((data: OrgData) => {
        const coo: Employee = {
          name: (settings.portalName ?? "Tengu").toLowerCase(),
          displayName: settings.portalName ?? "Tengu",
          department: "",
          rank: "executive",
          engine: "claude",
          model: "opus",
          persona: "COO and AI gateway daemon",
        };
        setEmployees([coo, ...data.employees]);
        setHierarchy(data.hierarchy);
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [settings.portalName]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  // Focus close button when panel opens
  useEffect(() => {
    if (selected && closeRef.current) {
      closeRef.current.focus();
    }
  }, [selected]);

  // ESC closes panel
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape" && selected) {
        setSelected(null);
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [selected]);

  const handleSelectEmployee = useCallback((emp: Employee) => {
    setSelected(emp);
  }, []);

  // After an inline edit: reload the org (so the map re-parents / re-layouts on
  // a reportsTo change) and refresh the open panel with the saved employee.
  const handleEmployeeUpdated = useCallback(
    (emp: Employee) => {
      loadData();
      setSelected(emp);
    },
    [loadData],
  );

  if (error) {
    return (
      <PageLayout>
        <div className="flex flex-col items-center justify-center h-full gap-[var(--space-4)] text-[var(--text-tertiary)]">
          <div className="rounded-[var(--radius-md,12px)] px-[var(--space-4)] py-[var(--space-3)] text-[length:var(--text-body)] text-[var(--system-red)]" style={{ background: "color-mix(in srgb, var(--system-red) 10%, transparent)", border: "1px solid color-mix(in srgb, var(--system-red) 30%, transparent)" }}>
            Failed to load organization: {error}
          </div>
          <button
            onClick={loadData}
            className="px-[var(--space-4)] py-[var(--space-2)] rounded-[var(--radius-md,12px)] bg-[var(--accent)] text-[var(--accent-contrast)] border-none cursor-pointer text-[length:var(--text-body)] font-[var(--weight-semibold)]"
          >
            Retry
          </button>
        </div>
      </PageLayout>
    );
  }

  return (
    <PageLayout>
      <div className="flex h-full relative bg-[var(--bg)]">
        {/* Map (the only view) */}
        <div className="flex-1 h-full relative">
          {loading ? (
            <div className="flex items-center justify-center h-full text-[var(--text-tertiary)] text-[length:var(--text-caption1)]">
              Loading...
            </div>
          ) : (
            <Suspense fallback={OrgMapFallback}>
              <OrgMap
                employees={employees}
                hierarchy={hierarchy}
                selectedName={selected?.name ?? null}
                onNodeClick={handleSelectEmployee}
              />
            </Suspense>
          )}
        </div>

        {/* Mobile backdrop */}
        {selected && (
          <div
            className="fixed inset-0 z-30 lg:hidden bg-black/50"
            onClick={() => setSelected(null)}
          />
        )}

        {/* Detail panel */}
        {selected && (
          <div className="absolute top-0 right-0 bottom-0 left-0 sm:left-auto z-30">
            <div className="w-full sm:w-[420px] lg:w-[468px] xl:w-[520px] max-w-[100vw] h-full overflow-y-auto bg-[var(--bg)] flex flex-col shadow-[var(--shadow-overlay)]">
              {/* Close button */}
              <div className="sticky top-0 z-10 flex items-center justify-end px-[var(--space-4)] py-[var(--space-3)] bg-[var(--bg)]">
                <button
                  ref={closeRef}
                  onClick={() => setSelected(null)}
                  aria-label="Close detail panel"
                  className="w-[30px] h-[30px] rounded-full flex items-center justify-center bg-[var(--fill-tertiary)] text-[var(--text-secondary)] border-none cursor-pointer text-sm"
                >
                  &#x2715;
                </button>
              </div>

              {/* Employee detail */}
              <div className="px-[var(--space-4)] pb-[var(--space-6)]">
                <EmployeeDetail
                  name={selected.name}
                  prefetched={selected.rank === "executive" ? selected : undefined}
                  onUpdated={handleEmployeeUpdated}
                />
              </div>
            </div>
          </div>
        )}
      </div>
    </PageLayout>
  );
}
