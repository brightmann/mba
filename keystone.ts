import { config, list } from '@keystone-6/core'
import {
  text,
  json,
  relationship,
  float,
  file,
  timestamp,
  checkbox,
  password,
} from '@keystone-6/core/fields'
import { withAuth, session } from './auth'

type AccessArgs = { session?: { data?: unknown } }
const isSignedIn = ({ session }: AccessArgs) => !!session
// Readers (including the static blog build) stay anonymous; writes need login.
const publicReadAdminWrite = {
  operation: {
    query: () => true,
    create: isSignedIn,
    update: isSignedIn,
    delete: isSignedIn,
  },
}
const adminOnly = {
  operation: {
    query: isSignedIn,
    create: isSignedIn,
    update: isSignedIn,
    delete: isSignedIn,
  },
}
// After a signed-in admin changes content, ask Render to rebuild the static
// frontend. Bootstrap/seed writes run without a session and never trigger it.
const triggerRedeploy = (context: { session?: unknown }) => {
  if (!context.session) return
  const url = process.env.REDEPLOY_HOOK_URL
  if (!url) return
  fetch(url, { method: 'POST' }).catch((err) =>
    console.warn('redeploy hook failed', err)
  )
}
import dayjs from 'dayjs'
import { Lists } from '.keystone/types'
import rt from 'reading-time'
import { preview } from './config/preview-field'
import path from 'node:path'
import fs from 'node:fs/promises'
import { createPosts } from './admin/api'

const Post: Lists.Post = list({
  fields: {
    isPublished: checkbox({ defaultValue: true }),
    slug: text({ isIndexed: 'unique' }),
    title: text({ defaultValue: 'default title' }),
    tags: relationship({
      // NOTE: 此时 grapql，tags 不是标量
      ref: 'Tag.posts',
      many: true,
      ui: { displayMode: 'select' },
    }),
    category: relationship({
      ref: 'Category.posts',
      many: false,
      ui: { displayMode: 'select' },
    }),
    attachment: relationship({
      ref: 'UploadPost.post',
      many: false,
      ui: {
        itemView: {
          fieldMode: 'hidden',
        },
        createView: {
          fieldMode: 'hidden',
        },
      },
    }),
    ctime: float({
      defaultValue: 0,
    }),
    mtime: float({ defaultValue: 0 }),
    date: text({ defaultValue: '' }),
    readingTime: text({
      ui: {
        itemView: {
          fieldMode: 'hidden',
        },
        createView: {
          fieldMode: 'hidden',
        },
      },
    }),
    prevArticle: relationship({
      ref: 'Post.nextArticle',
      many: false,
      ui: { hideCreate: true, displayMode: 'select' },
    }),
    nextArticle: relationship({
      ref: 'Post.prevArticle',
      many: false,
      ui: { hideCreate: true, displayMode: 'select' },
    }),
    brief: text({
      ui: {
        displayMode: 'textarea',
      },
    }),
    content: text({
      ui: {
        displayMode: 'textarea',
      },
    }),
  },
  hooks: {
    resolveInput: async ({ operation, resolvedData, context }) => {
      if (operation === 'create') {
        if (resolvedData.ctime === 0) {
          resolvedData.ctime = Date.now()
          resolvedData.date = dayjs().format('MM-DD')
        }
        resolvedData.readingTime = `${Math.trunc(
          rt(resolvedData.content || '').minutes
        )}`
      }

      return resolvedData
    },
    afterOperation: async ({ operation, item, context }) => {
      triggerRedeploy(context)
    },
    beforeOperation: async ({ operation, item, context }) => {
      if (operation === 'delete') {
        return
      }
    },
  },
  access: {
    ...publicReadAdminWrite,
    filter: { query: ({ session }) => session ? true : { isPublished: { equals: true } } },
  },
})

const Tag = list({
  fields: {
    name: text(),
    posts: relationship({
      ref: 'Post.tags',
      many: true,
      ui: { hideCreate: true },
    }),
  },
  access: publicReadAdminWrite,
  hooks: {
    afterOperation: async ({ context }) => {
      triggerRedeploy(context)
    },
  },
})

const Category = list({
  fields: {
    name: text(),
    posts: relationship({
      ref: 'Post.category',
      many: true,
      ui: { hideCreate: true },
    }),
  },
  access: publicReadAdminWrite,
  hooks: {
    afterOperation: async ({ context }) => {
      triggerRedeploy(context)
    },
  },
})

const UploadPost = list({
  fields: {
    isLive: checkbox({
      defaultValue: false,
      ui: {
        createView: {
          fieldMode: 'hidden',
        },
      },
    }),
    uploadTime: text({
      defaultValue: 'default time',
      hooks: {
        resolveInput() {
          return Date.now().toString()
        },
      },
    }),
    /**
     * 1. nextjs 生成的是静态网站，不适合用来动态预览内容
     * 2. 准确是不能动态生成预览内容页面，但可以用一个静态页面获取动态的内容展示
     */
    attachment: file({
      storage: 'local_file_storage',
    }),
    preview: preview(),
    post: relationship({
      ref: 'Post.attachment',
      many: false,
      ui: {
        createView: {
          fieldMode: 'hidden',
        },
        itemView: {
          fieldMode: 'read',
        },
      },
    }),
  },
  hooks: {
    async resolveInput({ resolvedData }) {
      if (resolvedData.attachment?.filename) {
        const filePath = path.join(
          process.cwd(),
          './_posts/',
          resolvedData.attachment.filename
        )
        const rawContent = await fs.readFile(filePath, 'utf8')
        resolvedData.preview = rawContent
      }
      return resolvedData
    },
    async afterOperation({ operation, originalItem, item, context }) {
      if (operation === 'update') {
        if (!originalItem.isLive && item.isLive) {
          const [{ id: postId }] = await createPosts([item.preview], context)
          await context.query.UploadPost.updateOne({
            // Retain the original markdown in Postgres after publication.
            data: { post: { connect: { id: postId } } },
            where: { id: item.id.toString() },
          })
          await context.query.Post.updateOne({
            data: { attachment: { connect: { id: item.id } } },
            where: { id: postId },
          })
        }
      }
    },
  },
  access: adminOnly,
})

const User = list({
  fields: {
    name: text(),
    email: text({ isIndexed: 'unique', validation: { isRequired: true } }),
    password: password({ validation: { isRequired: true } }),
  },
  // Users are provisioned by script/bootstrap.ts only; no public creation.
  access: {
    operation: {
      query: isSignedIn,
      create: () => false,
      update: isSignedIn,
      delete: () => false,
    },
  },
})

export default withAuth(
  config({
    db: {
      // DATABASE_URL (Neon) selects Postgres; unset keeps local SQLite dev.
      provider: process.env.DATABASE_URL ? 'postgresql' : 'sqlite',
      enableLogging: false,
      url:
        process.env.DATABASE_URL ||
        (process.env.NODE_ENV === 'production'
          ? 'file:./app.db'
          : 'file:./app-dev.db'),
    },
    session,
    graphql: {
      // Raise the GraphQL request body limit (express json() default is 100kb,
      // which rejected Brite's ~180kb post with HTTP 413 Payload Too Large).
      bodyParser: { limit: '10mb' },
    },
    server: {
      extendExpressApp: (app, commonContext) => {
        // Never serve unpublished markdown through an anonymous static route.
        // New imports retain raw markdown in Postgres; old imports remain in git.
        app.get('/files/:filename', async (req, res) => {
          const context = await commonContext.withRequest(req, res)
          if (!context.session?.data) { res.sendStatus(401); return }
          const filename = path.basename(req.params.filename)
          const upload = await context.prisma.uploadPost.findFirst({
            where: { attachment_filename: filename },
          })
          if (!upload) { res.sendStatus(404); return }
          try {
            const markdown = upload.preview ||
              await fs.readFile(path.join(process.cwd(), '_posts', filename), 'utf8')
            res.type('text/markdown').send(markdown)
          } catch { res.sendStatus(404) }
        })
      },
    },
    ui: {
      isAccessAllowed: (context) => !!context.session?.data,
    },
    experimental: {
      generateNextGraphqlAPI: true,
      generateNodeAPI: true,
    },
    lists: { Post, Tag, Category, UploadPost, User },
    storage: {
      local_file_storage: {
        kind: 'local',
        type: 'file',
        generateUrl: (path) => `/files${path}`,
        serverRoute: null,
        transformName: (filename) => {
          return filename
        },
        storagePath: '_posts',
      },
    },
  })
)
