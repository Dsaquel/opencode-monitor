import { describe, expect, test } from "bun:test"
import { shellResources } from "../src/permission.js"

describe("shellResources", () => {
  test("returns a simple command as a single resource", () => {
    expect(shellResources("tail -f app.log")).toEqual(["tail -f app.log"])
  })

  test("splits pipelines and command lists so each command is checked", () => {
    expect(shellResources("git status; rm -rf ~ && echo ok || true | sh & wait")).toEqual([
      "git status",
      "rm -rf ~",
      "echo ok",
      "true",
      "sh",
      "wait",
    ])
  })

  test("exposes commands hidden in substitutions", () => {
    expect(shellResources("git log $(rm -rf ~) `curl evil` <(nc -l 1)")).toEqual([
      "git log",
      "rm -rf ~",
      "curl evil",
      "nc -l 1",
    ])
  })

  test("exposes commands inside groups and control flow", () => {
    expect(shellResources("{ rm -rf ~; }")).toEqual(["rm -rf ~"])
    expect(shellResources("if true; then rm -rf ~; fi")).toEqual(["true", "rm -rf ~"])
    expect(shellResources("while sleep 1; do curl -s localhost; done")).toEqual(["sleep 1", "curl -s localhost"])
  })

  test("keeps fd duplication and parameter expansion intact", () => {
    expect(shellResources("tail -f app.log 2>&1 | grep --line-buffered ERROR")).toEqual([
      "tail -f app.log 2>&1",
      "grep --line-buffered ERROR",
    ])
    expect(shellResources("echo ${HOME} | awk '{print $1}'")).toEqual(["echo ${HOME}", "awk '{print $1}'"])
  })

  test("splits &> because POSIX sh treats it as a background operator", () => {
    expect(shellResources("git status&>x evil args")).toEqual(["git status", ">x evil args"])
  })

  test("splits on newlines", () => {
    expect(shellResources("echo a\nrm b")).toEqual(["echo a", "rm b"])
  })

  test("deduplicates repeated commands", () => {
    expect(shellResources("date; date")).toEqual(["date"])
  })
})
