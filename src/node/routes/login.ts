import { Router, Request } from "express"
import { promises as fs } from "fs"
import { RateLimiter as Limiter } from "limiter"
import * as path from "path"
import safeCompare from "safe-compare"
import { rootPath } from "../constants"
import { authenticated, getCookieDomain, redirect, replaceTemplates } from "../http"
import { hash, humanPath } from "../util"

export enum Cookie {
  Key = "key",
}

// RateLimiter wraps around the limiter library for logins.
// It allows 2 logins every minute and 12 logins every hour.
class RateLimiter {
  private readonly minuteLimiter = new Limiter(2, "minute")
  private readonly hourLimiter = new Limiter(12, "hour")

  public try(): boolean {
    if (this.minuteLimiter.tryRemoveTokens(1)) {
      return true
    }
    return this.hourLimiter.tryRemoveTokens(1)
  }
}

const getRoot = async (req: Request, error?: Error): Promise<string> => {
  const content = await fs.readFile(path.join(rootPath, "src/browser/pages/login.html"), "utf8")
  let passwordMsg = `Check the config file at ${humanPath(req.args.config)} for the password.`
  if (req.args.usingEnvPassword) {
    passwordMsg = "Password was set from $PASSWORD."
  } else if (req.args.usingEnvHashedPassword) {
    passwordMsg = "Password was set from $HASHED_PASSWORD."
  }
  return replaceTemplates(
    req,
    content
      .replace(/{{PASSWORD_MSG}}/g, passwordMsg)
      .replace(/{{ERROR}}/, error ? `<div class="error">${error.message}</div>` : ""),
  )
}

const limiter = new RateLimiter()

export const router = Router()

router.use((req, res, next) => {
  const to = (typeof req.query.to === "string" && req.query.to) || "/"
  if (authenticated(req)) {
    return redirect(req, res, to, { to: undefined })
  }
  next()
})

router.get("/", async (req, res) => {
  res.send(await getRoot(req))
})

router.post("/", async (req, res) => {
  try {
    if (!limiter.try()) {
      throw new Error("Login rate limited!")
    }

    if (!req.body.password) {
      throw new Error("Missing password")
    }

    if (
      req.args["hashed-password"]
        ? safeCompare(hash(req.body.password), req.args["hashed-password"])
        : req.args.password && safeCompare(req.body.password, req.args.password)
    ) {
      // The hash does not add any actual security but we do it for
      // obfuscation purposes (and as a side effect it handles escaping).
      res.cookie(Cookie.Key, hash(req.body.password), {
        maxAge: 600000, 
        domain: getCookieDomain(req.headers.host || "", req.args["proxy-domain"]),
        path: req.body.base || "/",
        sameSite: "lax",
      })

      const to = (typeof req.query.to === "string" && req.query.to) || "/"
      return redirect(req, res, to, { to: undefined })
    }

    console.error(
      "Failed login attempt",
      JSON.stringify({
        xForwardedFor: req.headers["x-forwarded-for"],
        remoteAddress: req.connection.remoteAddress,
        userAgent: req.headers["user-agent"],
        timestamp: Math.floor(new Date().getTime() / 1000),
      }),
    )

    throw new Error("Incorrect password")
  } catch (error) {
    res.send(await getRoot(req, error))
  }
})
