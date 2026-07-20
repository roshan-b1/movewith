/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Supabase project URL for anonymous usage counts. Unset = analytics off. */
  readonly VITE_SUPABASE_URL?: string
  /** Supabase anon (publishable) key. Safe to expose; the table is insert-only. */
  readonly VITE_SUPABASE_ANON_KEY?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
