export interface HonoEnv {
  Variables: {
    user: { id: string, email?: string | null, name?: string | null, role?: string | null } | null
    session: { id: string, userId: string } | null
  }
}
