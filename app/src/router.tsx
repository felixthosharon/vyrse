import { QueryClient } from "@tanstack/react-query";
import { createRouter, createHashHistory } from "@tanstack/react-router";
import { routeTree } from "./routeTree.gen";

export const getRouter = () => {
  const queryClient = new QueryClient();

  const router = createRouter({
    routeTree,
    context: { queryClient },
    scrollRestoration: true,
    defaultPreloadStaleTime: 0,
    // file:// + Electron has no server to rewrite unknown paths back to
    // index.html. Hash history keeps the file part of the URL fixed
    // (".../dist/index.html") and encodes routing state in the "#/..."
    // fragment instead — pure client-side, no path ever needs resolving.
    history: createHashHistory(),
  });

  return router;
};