import { AuthGate } from "./components/auth/AuthGate.js";
import { WorkspaceShell } from "./components/layout/WorkspaceShell.js";
import { registerSettingsNavigationRoutes } from "./lib/navigateAction.js";
import { ThemeProvider } from "./lib/theme.js";

registerSettingsNavigationRoutes();

export function App() {
  return (
    <ThemeProvider>
      <AuthGate>
        <WorkspaceShell />
      </AuthGate>
    </ThemeProvider>
  );
}

export default App;
