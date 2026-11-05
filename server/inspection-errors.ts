/** Only trusted inspection boundaries produce these categories; ordinary validation is not abuse. */
export class InspectionLimitError extends Error {
    constructor(readonly kind: "resource" | "timeout") {
        super(kind === "resource" ? "Inspection exceeded its resource limits" : "Inspection timed out");
        this.name = "InspectionLimitError";
    }
}
