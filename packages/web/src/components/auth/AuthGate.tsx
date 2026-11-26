import React, { useEffect, useState } from "react";
import type { Session, User } from "@supabase/supabase-js";
import { supabase } from "../../lib/supabase.js";
import { LoginView } from "./LoginView.js";

export interface AuthContextValue {
  session: Session | null;
  user: User | null;
  signOut: () => Promise<void>;
}

export const AuthContext = React.createContext<AuthContextValue | null>(null);

export function useAuth() {
  const context = React.useContext(AuthContext);
  if (!context) {
    throw new Error("useAuth must be used within an AuthGate");
  }
  return context;
}

export function AuthGate({ children }: { children: React.ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // Dev mode bypass for local visual testing and screenshots
    if (import.meta.env.DEV) {
      const urlParams = new URLSearchParams(window.location.search);
      if (urlParams.get("dev_bypass") === "true" || window.location.hash.includes("dev_bypass=true")) {
        setSession({
          access_token: "mock-token",
          token_type: "bearer",
          expires_in: 3600,
          refresh_token: "mock-refresh",
          user: {
            id: "dev-user",
            app_metadata: {},
            user_metadata: { full_name: "Angus (Dev)" },
            aud: "authenticated",
            created_at: new Date().toISOString(),
          },
        } as Session);
        setLoading(false);
        return;
      }
    }

    // 1. Initial session check
    supabase.auth.getSession().then(({ data: { session } }) => {
      setSession(session);
      setLoading(false);
    });

    // 2. Real-time auth state listener
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, session) => {
      setSession(session);
      setLoading(false);
    });

    return () => {
      subscription.unsubscribe();
    };
  }, []);

  const signOut = async () => {
    await supabase.auth.signOut();
  };

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-950 text-slate-400">
        <div className="flex flex-col items-center gap-3">
          <div className="w-8 h-8 border-2 border-indigo-500 border-t-transparent rounded-full animate-spin" />
          <p className="text-xs uppercase tracking-widest font-mono text-slate-400">
            Verifying ahOS Session...
          </p>
        </div>
      </div>
    );
  }

  // Strict blast-radius security: unauthenticated visitors cannot access any internal workspace surface
  if (!session) {
    return <LoginView />;
  }

  return (
    <AuthContext.Provider value={{ session, user: session.user, signOut }}>
      {children}
    </AuthContext.Provider>
  );
}
