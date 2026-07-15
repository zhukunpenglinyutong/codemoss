// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Home } from "./Home";

vi.mock("react-i18next", () => ({
  initReactI18next: { type: "3rdParty", init: () => {} },
  useTranslation: () => ({
    t: (key: string) => {
      const translations: Record<string, string> = {
        "app.title": "CodePort",
        "app.subtitle": "Your AI coding companion",
        "home.welcome": "Welcome",
        "home.subtitle": "What would you like to build today?",
        "home.openProject": "Add project",
      };
      return translations[key] || key;
    },
    i18n: { language: "en", changeLanguage: vi.fn() },
  }),
  Trans: ({ children }: { children: React.ReactNode }) => children,
}));

const baseProps = {
  onOpenProject: vi.fn(),
  latestAgentRuns: [],
  isLoadingLatestAgents: false,
  onSelectThread: vi.fn(),
};

describe("Home", () => {
  it("renders the hero copy and add-project action", () => {
    render(<Home {...baseProps} />);

    expect(screen.getByText("Welcome")).toBeTruthy();
    expect(screen.getByText("What would you like to build today?")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Add project" })).toBeTruthy();
  });

  it("opens the project picker from the main action", () => {
    const onOpenProject = vi.fn();
    const { container } = render(<Home {...baseProps} onOpenProject={onOpenProject} />);

    const actionButton = container.querySelector(".home-primary-button");
    expect(actionButton).toBeTruthy();
    if (!actionButton) {
      throw new Error("Expected home primary action button");
    }
    fireEvent.click(actionButton);
    expect(onOpenProject).toHaveBeenCalledTimes(1);
  });
});
