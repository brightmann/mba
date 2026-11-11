/**
 * First-start bootstrap for the deployed CMS. Runs before `keystone start`.
 *
 * 1. Creates the first admin User from ADMIN_EMAIL / ADMIN_PASSWORD env vars
 *    when no users exist, so the public sign-in page never offers open
 *    first-user enrollment.
 * 2. Seeds Post/Tag/Category/UploadPost rows from script/seed-data.json
 *    (an exact export of the committed SQLite app.db) when the database is
 *    empty. Raw prisma writes preserve the original ids, timestamps and
 *    relations; app.db itself stays untouched in the repo.
 */
import fs from 'node:fs'
import path from 'node:path'
import { keystoneContext } from '../context'

async function main() {
  const context = keystoneContext.sudo()
  const prisma = context.prisma as any

  const userCount = await prisma.user.count()
  if (userCount === 0) {
    const email = process.env.ADMIN_EMAIL
    const password = process.env.ADMIN_PASSWORD
    if (email && password) {
      await context.query.User.createOne({
        data: { name: 'Brite', email, password },
        query: 'id',
      })
      console.log('bootstrap: admin user created for', email)
    } else {
      console.warn(
        'bootstrap: no users yet and ADMIN_EMAIL/ADMIN_PASSWORD unset; admin sign-in will stay disabled'
      )
    }
  } else {
    console.log('bootstrap: users already exist:', userCount)
  }

  const postCount = await prisma.post.count()
  if (postCount > 0) {
    console.log('bootstrap: posts already exist:', postCount)
    return
  }

  const seed = JSON.parse(
    fs.readFileSync(path.join(__dirname, 'seed-data.json'), 'utf8')
  )
  for (const t of seed.Tag) {
    await prisma.tag.create({ data: { id: t.id, name: t.name } })
  }
  for (const c of seed.Category) {
    await prisma.category.create({ data: { id: c.id, name: c.name } })
  }
  for (const u of seed.UploadPost) {
    await prisma.uploadPost.create({
      data: {
        id: u.id,
        isLive: !!u.isLive,
        uploadTime: u.uploadTime,
        attachment_filesize: u.attachment_filesize,
        attachment_filename: u.attachment_filename,
        preview: u.preview,
      },
    })
  }
  for (const p of seed.Post) {
    await prisma.post.create({
      data: {
        id: p.id,
        slug: p.slug,
        title: p.title,
        ctime: p.ctime,
        mtime: p.mtime,
        date: p.date,
        readingTime: p.readingTime,
        brief: p.brief,
        content: p.content,
        categoryId: p.category,
        attachmentId: p.attachment,
      },
    })
  }
  // Post->Post links need every row to exist first.
  for (const p of seed.Post) {
    if (p.nextArticle) {
      await prisma.post.update({
        where: { id: p.id },
        data: { nextArticleId: p.nextArticle },
      })
    }
  }
  for (const j of seed._Post_tags) {
    await prisma.post.update({
      where: { id: j.A },
      data: { tags: { connect: { id: j.B } } },
    })
  }
  console.log(
    `bootstrap: seeded ${seed.Post.length} posts, ${seed.Tag.length} tags, ${seed.Category.length} categories, ${seed.UploadPost.length} uploads`
  )
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('bootstrap failed', err)
    process.exit(1)
  })
