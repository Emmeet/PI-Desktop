import { ErrorBoundary } from "./features/app/chrome";
import { AppShell } from "./features/app/AppShell";
import { OmpThemeSync } from "./features/omp/OmpThemeSync";

export default function App() {
  return (
    <ErrorBoundary>
      <AppShell />
      <OmpThemeSync />
    </ErrorBoundary>
  );
}
