import type { FastifyInstance, InjectOptions } from "fastify";

/** Sign in test actors that need an already-onboarded account. Tests of the
 * first-login gate should call app.inject directly instead. */
export async function loginEstablishedUser(app: FastifyInstance, options: InjectOptions) {
  const response = await app.inject(options);
  if (response.statusCode === 200 && response.json().user?.mustChangePassword) {
    const password = (options.payload as { password: string }).password;
    const cookie = String(response.headers["set-cookie"]).split(";")[0];
    const temporary = `${password}-rotated`;
    for (const [currentPassword, newPassword] of [[password, temporary], [temporary, password]]) {
      const change = await app.inject({ method: "PUT", url: "/api/me/password", headers: { cookie }, payload: { currentPassword, newPassword } });
      if (change.statusCode !== 200) throw new Error(`Test account onboarding failed: ${change.body}`);
    }
  }
  return response;
}
