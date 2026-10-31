import { Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ResolveReportDto } from './dto/resolve-report.dto';
import { ReviewContentDto } from './dto/review-content.dto';

@Injectable()
export class ManualModerationService {

  constructor(
    private readonly prisma: PrismaService,
  ) {}

  // --- 1. Retrieve content requiring manual moderation ---

  // Each report is returned together with the content it points to (and the
  // usernames involved), so moderators can review it without extra requests.
  // `target` is null when the content no longer exists (its author deleted it).
  async findAllReports(status?: string) {
    const reports = await this.prisma.report.findMany({
      where: status ? { status } : undefined,
      orderBy: {
        createdAt: 'desc',
      },
    });

    const postIds = reports
      .filter((r) => r.targetType === 'post')
      .map((r) => r.targetId);
    const commentIds = reports
      .filter((r) => r.targetType === 'comment')
      .map((r) => r.targetId);

    const [posts, comments] = await Promise.all([
      this.prisma.post.findMany({
        where: { id: { in: postIds } },
        select: {
          id: true,
          title: true,
          content: true,
          status: true,
          authorId: true,
          createdAt: true,
        },
      }),
      this.prisma.comment.findMany({
        where: { id: { in: commentIds } },
        select: {
          id: true,
          content: true,
          status: true,
          authorId: true,
          postId: true,
          createdAt: true,
        },
      }),
    ]);

    const userIds = new Set<number>();
    for (const r of reports) {
      userIds.add(r.reporterId);
      if (r.moderatorId) userIds.add(r.moderatorId);
    }
    for (const p of posts) userIds.add(p.authorId);
    for (const c of comments) userIds.add(c.authorId);

    const users = await this.prisma.user.findMany({
      where: { id: { in: Array.from(userIds) } },
      select: { id: true, username: true },
    });

    const usernames = new Map(users.map((u) => [u.id, u.username] as const));
    const postsById = new Map(posts.map((p) => [p.id, p] as const));
    const commentsById = new Map(comments.map((c) => [c.id, c] as const));

    return reports.map((r) => {
      const target =
        r.targetType === 'post'
          ? postsById.get(r.targetId)
          : commentsById.get(r.targetId);

      return {
        ...r,
        reporterUsername: usernames.get(r.reporterId) ?? null,
        moderatorUsername: r.moderatorId
          ? (usernames.get(r.moderatorId) ?? null)
          : null,
        target: target
          ? {
              ...target,
              authorUsername: usernames.get(target.authorId) ?? null,
            }
          : null,
      };
    });
  }

  // Posts and comments the automatic moderation flagged for human review.
  // Each item also carries the author's username (and, for comments, the title
  // of the post they belong to) so the moderation screen can show context.
  async findPendingContent() {

    // Promise.all() runs both independent queries concurrently and waits for both to resolve
    const [posts, comments] = await Promise.all([   // Array destructuring: creates two variables from the two results
      this.prisma.post.findMany({
        where: {
          status: 'pending',
        },
        orderBy: {
          createdAt: 'desc',
        },
      }),

      this.prisma.comment.findMany({
        where: {
          status: 'pending',
        },
        orderBy: {
          createdAt: 'desc',
        },
      }),
    ]);

    const userIds = [
      ...new Set([
        ...posts.map((p) => p.authorId),
        ...comments.map((c) => c.authorId),
      ]),
    ];
    const parentPostIds = [...new Set(comments.map((c) => c.postId))];

    const [users, parentPosts] = await Promise.all([
      this.prisma.user.findMany({
        where: { id: { in: userIds } },
        select: { id: true, username: true },
      }),
      this.prisma.post.findMany({
        where: { id: { in: parentPostIds } },
        select: { id: true, title: true },
      }),
    ]);

    const usernames = new Map(users.map((u) => [u.id, u.username] as const));
    const titles = new Map(parentPosts.map((p) => [p.id, p.title] as const));

    return {      // Returns both arrays grouped in a JavaScript object
      posts: posts.map((p) => ({
        ...p,
        authorUsername: usernames.get(p.authorId) ?? null,
      })),
      comments: comments.map((c) => ({
        ...c,
        authorUsername: usernames.get(c.authorId) ?? null,
        postTitle: titles.get(c.postId) ?? null,
      })),
    };
  }

  // --- 2. Apply manual moderation decisions ---

  async resolveReport(                          // manual moderation action
	reportId: number,
	resolveReportDto: ResolveReportDto,
	moderatorId: number,
  ) {
	const report = await this.prisma.report.findUnique({
	  where: { id: reportId },
	});

	if (!report) {
	  throw new NotFoundException(
		`Report with id ${reportId} not found`,
	  );
	}

	if (report.status !== 'pending') {
	  throw new BadRequestException(
		`Report with id ${reportId} has already been resolved`,
	  );
	}

	if (report.targetType === 'post') {
	  const post = await this.prisma.post.findUnique({
		where: { id: report.targetId },
	  });

	  // The author may have deleted the post after it was reported. The
	  // report can still be closed; there is just nothing left to remove.
	  if (post && resolveReportDto.action === 'remove') {     // Soft moderation instead of a hard delete - the record stays in the DB
		await this.prisma.post.update({
		  where: { id: report.targetId },
		  data: { status: 'removed' },
		});
	  }
	}

	if (report.targetType === 'comment') {
	  const comment = await this.prisma.comment.findUnique({
		where: { id: report.targetId },
	  });

	  // Same as above: the comment may already have been deleted.
	  if (comment && resolveReportDto.action === 'remove') {
		await this.prisma.comment.update({
		  where: { id: report.targetId },
		  data: { status: 'removed' },
		});
	  }
	}

	const updatedReport = await this.prisma.report.update({
	  where: { id: reportId },
	  data: {
		status: 'resolved',
		resolution: resolveReportDto.action,
		moderatorId: moderatorId,
		moderatorNote: resolveReportDto.note,
		reviewedAt: new Date(),
	  },
	});

	await this.prisma.moderationLog.create({
	  data: {
		reportId,
		targetType: report.targetType,
		targetId: report.targetId,
		action: resolveReportDto.action,
		reason: resolveReportDto.note,
		moderatorId: moderatorId,
	  },
	});

	return updatedReport;
  }

  async reviewPendingPost(
    postId: number,
    reviewContentDto: ReviewContentDto,
    moderatorId: number,
  ) {
    const post = await this.prisma.post.findUnique({
      where: { id: postId },
    });

    if (!post) {
      throw new NotFoundException(
        `Post with id ${postId} not found`,
      );
    }

    if (post.status !== 'pending') {
      throw new BadRequestException(
        `Post with id ${postId} is not pending review`,
      );
    }

    const newStatus =
      reviewContentDto.action === 'approve'
        ? 'visible'
        : 'removed';

    const updatedPost = await this.prisma.post.update({
      where: { id: postId },
      data: {
        status: newStatus,
      },
    });

    await this.prisma.moderationLog.create({
      data: {
        reportId: null,
        targetType: 'post',
        targetId: postId,
        action: reviewContentDto.action,
        reason: reviewContentDto.note,
        moderatorId,
      },
    });

    return updatedPost;
  }

  async reviewPendingComment(
    commentId: number,
    reviewContentDto: ReviewContentDto,
    moderatorId: number,
  ) {
    const comment = await this.prisma.comment.findUnique({
      where: { id: commentId },
    });

    if (!comment) {
      throw new NotFoundException(
        `Comment with id ${commentId} not found`,
      );
    }

    if (comment.status !== 'pending') {
      throw new BadRequestException(
        `Comment with id ${commentId} is not pending review`,
      );
    }

    const newStatus =
      reviewContentDto.action === 'approve'
        ? 'visible'
        : 'removed';

    const updatedComment = await this.prisma.comment.update({
      where: { id: commentId },
      data: {
        status: newStatus,
      },
    });

    await this.prisma.moderationLog.create({
      data: {
        reportId: null,
        targetType: 'comment',
        targetId: commentId,
        action: reviewContentDto.action,
        reason: reviewContentDto.note,
        moderatorId,
      },
    });

    return updatedComment;
  }

  // --- 3. Retrieve manual moderation history ---

  findAllModerationLogs() {
    return this.prisma.moderationLog.findMany({
      orderBy: {
        createdAt: 'desc',
      },
    });
  }
}