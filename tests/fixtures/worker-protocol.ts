export {};

if (process.argv[2] === "hang") {
    await Bun.sleep(60000);
} else if (["resource-error", "timeout-error"].includes(process.argv[2])) {
    console.error("Submission rejected: classified inspection limit");
    process.exitCode = process.argv[2] === "resource-error" ? 2 : 3;
} else if (process.argv[2] === "early-error") {
    console.error("Submission rejected: Cannot resolve HEAD");
    process.exitCode = 1;
} else {
    const commit = "a".repeat(40);
    await Bun.write(Bun.stdout, `${commit}\n`);

    if (await Bun.stdin.text() !== "inspect\n") {
        throw new Error("Inspection was not authorized");
    }

    if (process.argv[2] === "gated-hang") {
        await Bun.sleep(60000);
    } else if (process.argv[2] === "huge-output") {
        await Bun.write(Bun.stdout, Buffer.alloc(600000));
    } else {
        await Bun.write(Bun.stdout, `${JSON.stringify({ commit, title: "Game", description: "Small" })}\nimage`);
    }
}
