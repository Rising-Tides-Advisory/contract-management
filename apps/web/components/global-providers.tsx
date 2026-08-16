"use client"

import { KeyboardShortcutsModal } from "@/components/keyboard-shortcuts-modal"
import { OnboardingModal } from "@/components/onboarding-modal"

// The ⌘K palette lives in <CmdK /> (app/(app)/layout.tsx). A second palette
// used to be mounted here as well; both bound ⌘K, so both opened at once and
// the one on top answered every contract query with "No results found".
export function GlobalProviders() {
  return (
    <>
      <KeyboardShortcutsModal />
      <OnboardingModal />
    </>
  )
}

export default GlobalProviders
