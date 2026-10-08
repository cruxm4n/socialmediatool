import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import WebSocket from "ws";

/*
 * Exécuté avant chaque page : rafraîchit la session Supabase et renvoie
 * vers la connexion les visiteurs non authentifiés.
 * Les droits fins (admin, client, organisation) sont vérifiés dans les pages et par la base.
 */
export async function proxy(request: NextRequest) {
  let response = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
    {
      realtime: { transport: WebSocket as unknown as typeof globalThis.WebSocket },
      cookies: {
        getAll: () => request.cookies.getAll(),
        setAll: (items) => {
          for (const { name, value } of items) request.cookies.set(name, value);
          response = NextResponse.next({ request });
          for (const { name, value, options } of items) response.cookies.set(name, value, options);
        },
      },
    },
  );

  const { data } = await supabase.auth.getUser();
  const { pathname } = request.nextUrl;

  // Une action serveur (envoi de formulaire, clic) n'est pas redirigée : elle vérifie elle-même la session
  // et répond « session expirée », ce que l'interface sait afficher. Une redirection ici resterait sans effet visible.
  const isServerAction = request.method === "POST" && request.headers.has("next-action");

  if (!data.user && pathname !== "/connexion" && !isServerAction) {
    const url = request.nextUrl.clone();
    url.pathname = "/connexion";
    url.search = "";
    return NextResponse.redirect(url);
  }
  return response;
}

export const config = {
  // Tout sauf les fichiers statiques et les routes d'automatisation (protégées par leur propre secret).
  matcher: ["/((?!_next/static|_next/image|favicon.ico|demo-media/|api/automation/).*)"],
};
