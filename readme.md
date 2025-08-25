# veloserver

A web server framework for high-performance websites.

Example simple server:
```ts
import {App, Router, Context, Mode} from "jsr:@velotype/veloserver"

const router: Router = new Router()

router.get("/", function(_request: Request, _context: Context) {
    const response = new Response(`
<html><body>
<div>Hello veloserver!</div>
</body></html>
`, {status: 200})
    response.headers.set("content-type", "text/html; charset=utf-8")
    return response
})

const app = new App(router)
app.serve("127.0.0.1", 3000)
```