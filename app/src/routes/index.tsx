import { createFileRoute } from "@tanstack/react-router";
import { VyrseApp } from "@/components/VyrseApp";
import { VyrseProvider } from "@/lib/vyrse/store";

const TITLE = "Vyrse — A personal AI presence";
const DESCRIPTION =
  "Vyrse is a voice-first personal AI presence: a living computational field that listens, thinks and responds. Prototype interface.";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: TITLE },
      { name: "description", content: DESCRIPTION },
      { property: "og:title", content: TITLE },
      { property: "og:description", content: DESCRIPTION },
    ],
  }),
  component: Index,
});

function Index() {
  return (
    <VyrseProvider>
      <VyrseApp />
    </VyrseProvider>
  );
}
