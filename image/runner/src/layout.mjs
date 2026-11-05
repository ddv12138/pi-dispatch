/**
 * Where a job's files sit inside the container (INT-CONTAINER-JOB-INPUTS): one closed table, never a path.
 *
 * Every venue binds the job's directories into the container: `/job`, `/workspace`, `/session`, `/outbox`,
 * `/inbox` and `/opt/pi-global`, exactly the paths every runner before issue #683 used. (That issue's second
 * layout for venues that COPY their files, and the `PI_JOB_LAYOUT` variable that chose between the two, went
 * when those venues did; the table stays because these paths still have exactly one home.)
 *
 * WHY A TABLE AND NOT A ROOT PATH. These are module constants the runner imports, never a free string it
 * trusts for every read it makes, including the prompt and the MCP config: a job cannot move them, and the
 * one test beside this file refuses any runner source that spells one as a literal.
 */
export const LAYOUT = Object.freeze({ job: "/job", workspace: "/workspace", session: "/session", outbox: "/outbox", inbox: "/inbox", global: "/opt/pi-global" });
