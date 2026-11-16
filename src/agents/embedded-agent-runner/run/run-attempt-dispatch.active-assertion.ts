/** The admitted-run liveness check that embedded attempt dispatch requires at each stage.
 *
 * Split out of ./run-attempt-dispatch.ts to keep that module within the
 * max-lines budget.
 */
import {
  type AdmittedRunContext,
  resolveAdmittedRunActiveAssertion,
} from "../../admitted-run-context.js";

/** Binds dispatch's active-run check; each call throws once the admitted run is not active. */
export function createRequireActiveAssertion(admittedRunContext: AdmittedRunContext) {
  return (signal?: AbortSignal) => {
    const assertion = resolveAdmittedRunActiveAssertion(admittedRunContext, signal);
    if (!assertion) {
      throw new Error("embedded attempt reached dispatch without an active admitted run");
    }
    return assertion;
  };
}
