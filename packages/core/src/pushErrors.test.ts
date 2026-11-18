import { expect, test } from "bun:test"
import { describePushFailure } from "./pushErrors"

const rejected = `To https://github.com/example/repo.git
 ! [rejected]        feature/x -> feature/x (fetch first)
error: failed to push some refs to 'https://github.com/example/repo.git'
hint: Updates were rejected because the remote contains work that you do not
hint: have locally.`

test("a rejected plain push explains the remote has commits the branch lacks", () => {
    const message = describePushFailure({
        stderr: rejected,
        branch: "feature/x",
        remoteBranch: "feature/x",
        force: false,
    })
    expect(message).toContain("origin/feature/x has commits")
    expect(message).toContain("would overwrite them")
    expect(message).toContain("different remote branch name")
    expect(message).not.toContain("[rejected]")
})

test("a non-fast-forward rejection is classified the same way", () => {
    const message = describePushFailure({
        stderr: " ! [rejected] a -> a (non-fast-forward)",
        branch: "a",
        remoteBranch: "b",
        force: false,
    })
    expect(message).toContain("origin/b has commits")
})

test("a refused force push says the remote commits were not overwritten", () => {
    const message = describePushFailure({
        stderr: " ! [rejected] a -> a (fetch first)",
        branch: "a",
        remoteBranch: "a",
        force: true,
    })
    expect(message).toContain("force push was refused")
})

test("a lease failure says the remote moved since the last fetch", () => {
    const message = describePushFailure({
        stderr: " ! [rejected] a -> a (stale info)",
        branch: "a",
        remoteBranch: "a",
        force: true,
    })
    expect(message).toContain("changed on the remote")
    expect(message).toContain("Fetch the branch")
})

test("credential failures name the login problem", () => {
    const message = describePushFailure({
        stderr: "remote: Permission to example/repo.git denied to someone.",
        branch: "a",
        remoteBranch: "a",
        force: false,
    })
    expect(message).toContain("rejected the credentials")
})

test("unrecognised failures keep git's own output", () => {
    const message = describePushFailure({
        stderr: "fatal: unable to access something\n",
        branch: "a",
        remoteBranch: "a",
        force: false,
    })
    expect(message).toBe("fatal: unable to access something")
})

test("an empty failure still names the branch", () => {
    const message = describePushFailure({
        stderr: "",
        branch: "a",
        remoteBranch: "a",
        force: false,
    })
    expect(message).toBe("Could not push 'a'.")
})
