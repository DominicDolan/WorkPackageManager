import { describe, expect, test } from "bun:test"
import { machineArgv, shellQuote } from "./agents"
import { DEFAULT_CONFIG, merge } from "./config/config"

describe("machines config", () => {
    test("defaults to none", () => {
        expect(merge({}).machines).toEqual({})
        expect(DEFAULT_CONFIG.machines).toEqual({})
    })

    test("accepts a command string or argv, and optional fields", () => {
        const { machines } = merge({
            machines: {
                box: { command: "docker exec -i -w /work box" },
                remote: {
                    label: "Build server",
                    command: ["ssh", "build", "cd ~/repo &&"],
                    interactiveCommand: ["ssh", "-t", "build", "cd ~/repo &&"],
                    shell: true,
                    harnesses: ["claude", "claude"],
                },
            },
        })
        expect(machines.box).toEqual({
            command: ["docker", "exec", "-i", "-w", "/work", "box"],
        })
        expect(machines.remote).toEqual({
            label: "Build server",
            command: ["ssh", "build", "cd ~/repo &&"],
            interactiveCommand: ["ssh", "-t", "build", "cd ~/repo &&"],
            shell: true,
            harnesses: ["claude"],
        })
    })

    test("rejects what it cannot use", () => {
        expect(() => merge({ machines: [] })).toThrow("object keyed")
        expect(() => merge({ machines: { box: {} } })).toThrow(
            "machines.box.command",
        )
        expect(() =>
            merge({ machines: { local: { command: "true" } } }),
        ).toThrow("this computer")
        expect(() =>
            merge({ machines: { "a b": { command: "true" } } }),
        ).toThrow("letters, digits")
        expect(() =>
            merge({
                machines: { box: { command: "true", harnesses: ["gemini"] } },
            }),
        ).toThrow("harnesses")
        expect(() =>
            merge({ machines: { box: { command: "true", cmd: "x" } } }),
        ).toThrow("unknown key(s): cmd")
    })
})

describe("machineArgv", () => {
    const docker = {
        command: ["docker", "exec", "-i", "box"],
        interactiveCommand: ["docker", "exec", "-it", "box"],
    }

    test("headless runs pass the headless environment through env", () => {
        expect(
            machineArgv(docker, ["claude", "-p", "hi there"], false),
        ).toEqual([
            "docker",
            "exec",
            "-i",
            "box",
            "env",
            "CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1",
            "claude",
            "-p",
            "hi there",
        ])
    })

    test("interactive runs use the interactive prefix, falling back to command", () => {
        expect(machineArgv(docker, ["claude", "hi"], true)).toEqual([
            "docker",
            "exec",
            "-it",
            "box",
            "claude",
            "hi",
        ])
        expect(
            machineArgv(
                { command: ["docker", "exec", "-i", "box"] },
                ["x"],
                true,
            ),
        ).toEqual(["docker", "exec", "-i", "box", "x"])
    })

    test("shell machines get one quoted string a shell reads back exactly", () => {
        const prompt = 'Line one\nit\'s "quoted" $HOME `tick` \\ back'
        const argv = machineArgv(
            { command: ["sh", "-c"], shell: true },
            ["printf", "%s|", "a b", prompt],
            true,
        )
        expect(argv).toHaveLength(3)
        const ran = Bun.spawnSync(argv)
        expect(ran.stdout.toString()).toBe(`a b|${prompt}|`)
    })

    test("shellQuote leaves plain words alone", () => {
        expect(shellQuote("--model")).toBe("--model")
        expect(shellQuote("a/b:c=d")).toBe("a/b:c=d")
        expect(shellQuote("")).toBe("''")
    })
})
