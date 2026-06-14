import { BarChart3, Bot, LayoutDashboard, Settings, Wrench } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import BithumbTestPage from "./pages/BithumbTestPage";
import DashboardPage from "./pages/DashboardPage";
import SettingsPage from "./pages/SettingsPage";
import SimulationPage from "./pages/SimulationPage";
import TradingPage from "./pages/TradingPage";

type RoutePath = "/" | "/dashboard" | "/trading" | "/bithumb-test" | "/settings";

const routes: Array<{
  path: RoutePath;
  label: string;
  icon: typeof BarChart3;
}> = [
  { path: "/", label: "시뮬레이션", icon: BarChart3 },
  { path: "/dashboard", label: "대시보드", icon: LayoutDashboard },
  { path: "/trading", label: "자동매매", icon: Bot },
  { path: "/bithumb-test", label: "개발자 테스트", icon: Wrench },
  { path: "/settings", label: "설정", icon: Settings }
];

export default function App() {
  const [path, setPath] = useState<RoutePath>(normalizePath(window.location.pathname));
  const [serverStartedAt, setServerStartedAt] = useState("");
  const activeRoute = useMemo(() => routes.find((route) => route.path === path) ?? routes[0], [path]);

  useEffect(() => {
    function handlePopState() {
      setPath(normalizePath(window.location.pathname));
    }

    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, []);

  useEffect(() => {
    let isMounted = true;

    async function loadServerRuntime() {
      try {
        const response = await fetch("/api/health");
        const payload = (await response.json()) as { server?: { startedAt?: string } };
        if (isMounted) {
          setServerStartedAt(payload.server?.startedAt ?? "");
        }
      } catch {
        if (isMounted) {
          setServerStartedAt("");
        }
      }
    }

    loadServerRuntime();
    const timer = window.setInterval(loadServerRuntime, 5_000);

    return () => {
      isMounted = false;
      window.clearInterval(timer);
    };
  }, []);

  function navigate(nextPath: RoutePath) {
    window.history.pushState(null, "", nextPath);
    setPath(nextPath);
  }

  return (
    <>
      <nav className="appNav" aria-label="주요 페이지">
        <div className="appBrandCluster">
          <div className="appBrand">
            <strong>Slice Trade</strong>
            <span>Seven Split</span>
          </div>
          <div className="serverDeployTime">
            <span>서버 배포 시간</span>
            <strong>{formatOptionalDateTime(serverStartedAt)}</strong>
          </div>
        </div>
        <div className="navTabs">
          {routes.map((route) => {
            const Icon = route.icon;
            return (
              <button
                key={route.path}
                className={route.path === activeRoute.path ? "active" : ""}
                onClick={() => navigate(route.path)}
                type="button"
              >
                <Icon size={16} />
                {route.label}
              </button>
            );
          })}
        </div>
      </nav>

      {path === "/" && <SimulationPage />}
      {path === "/dashboard" && <DashboardPage />}
      {path === "/trading" && <TradingPage />}
      {path === "/bithumb-test" && <BithumbTestPage />}
      {path === "/settings" && <SettingsPage />}
    </>
  );
}

function normalizePath(path: string): RoutePath {
  if (path === "/dashboard" || path === "/trading" || path === "/bithumb-test" || path === "/settings") {
    return path;
  }

  return "/";
}

function formatOptionalDateTime(value: string) {
  if (!value) {
    return "-";
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "-";
  }

  return date.toLocaleString("ko-KR", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  });
}
