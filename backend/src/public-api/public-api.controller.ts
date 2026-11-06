import { Body, Controller, Delete, Get, Param, Post, Put, Patch, Query, UseGuards } from '@nestjs/common';
import { UsersService } from '../users/users.service';
import { ForumService } from '../forum/forum.service';
import { AdminIdentityService } from './admin-identity.service';
import { ManualModerationService } from '../moderation/manual-moderation.service';
import { CreatePostDto } from '../forum/dto/create-post.dto';
import { ResolveReportDto } from '../moderation/dto/resolve-report.dto';
import { UpdateUserRoleDto } from '../users/update-user-role.dto';
import { AdminApiKeyGuard } from './admin-api-key.guard';
import { AdminApiRateLimitGuard } from './admin-api-rate-limit.guard';
import {
  ApiTags,
  ApiSecurity,
  ApiOperation,
  ApiResponse,
  ApiParam,
  ApiQuery,
} from '@nestjs/swagger';

@ApiTags('Public Admin API')                            // Groups endpoints under "Public Admin API" in the Swagger documentation
@ApiSecurity('admin-api-key')                           // Indicates that endpoints use the "admin-api-key" security scheme in the OpenAPI documentation
@UseGuards(AdminApiKeyGuard, AdminApiRateLimitGuard)    // A NestJS Guard determines whether a request can proceed to the handler
@Controller('api/admin')                                // Identifies this class as a NestJS controller and defines the route prefix
export class PublicApiController {

  constructor(                                         //Dependency Injection (DI)
    private readonly usersService: UsersService,          // private: restricts direct access to the property to within the class (TypeScript access control)
    private readonly forumService: ForumService,          // readonly: prevents reassignment of the property (TypeScript compile-time enforcement)
    private readonly manualModerationService: ManualModerationService,
    private readonly adminIdentityService: AdminIdentityService,
  ) {}

  @ApiOperation({ summary: 'List all users' })                                  // Describes the operation in Swagger documentation
  @ApiResponse({ status: 200, description: 'Users retrieved successfully' })    // Documents the HTTP 200 response (does not generate it)
  @Get('users')
  getUsers() {
    return this.usersService.findAll();
  }

  @ApiOperation({ summary: 'Update a user role' })
  @ApiParam({             // Documents the 'id' route parameter as a number in Swagger (does not validate or convert it)
    name: 'id',
    type: Number,
  })
  @ApiResponse({ status: 200, description: 'User role updated successfully' })
  @ApiResponse({ status: 400, description: 'Invalid role or ADMIN role cannot be changed' })
  @ApiResponse({ status: 404, description: 'User not found' })
  @Put('users/:id/role')                                          // :id is a dynamic route parameter
  updateUserRole(
    @Param('id') id: string,
    @Body() updateUserRoleDto: UpdateUserRoleDto,
  ) {
    return this.usersService.updateRole(
      Number(id),
      updateUserRoleDto.role,
    );
  }

  @ApiOperation({ summary: 'List moderation reports' })
  @ApiQuery({                                                 // Documents the query parameter in Swagger (does not validate it)
    name: 'status',
    required: false,                                          // Indicates that the parameter is optional
    description: 'Filter reports by status',
  })
  @ApiResponse({ status: 200, description: 'Reports retrieved successfully' })
  @Get('reports')
  getReports(@Query('status') status?: string) {
    return this.manualModerationService.findAllReports(status);
  }

  @ApiOperation({ summary: 'Resolve a moderation report' })
  @ApiParam({
    name: 'id',
    type: Number,
  })
  @ApiResponse({ status: 200, description: 'Report resolved successfully' })
  @ApiResponse({ status: 404, description: 'Report not found' })
  @Patch('reports/:id/resolve')
  async resolveReport(
    @Param('id') id: string,
    @Body() resolveReportDto: ResolveReportDto,
  ) {
    const adminId =
      await this.adminIdentityService.getAdminId();

    return this.manualModerationService.resolveReport(
      Number(id),
      resolveReportDto,
      adminId,
    );
  }

  @ApiOperation({ summary: 'List content pending moderation' })
  @ApiResponse({ status: 200, description: 'Pending content retrieved successfully' })
  @Get('moderation/pending')
  getPendingContent() {
    return this.manualModerationService.findPendingContent();
  }

  @ApiOperation({ summary: 'List moderation logs' })
  @ApiResponse({ status: 200, description: 'Moderation logs retrieved successfully' })
  @Get('moderation/logs')
  getModerationLogs() {
    return this.manualModerationService.findAllModerationLogs();
  }

  @ApiOperation({ summary: 'Create a post as the administrator' })
  @ApiResponse({ status: 201, description: 'Post created successfully' })
  @ApiResponse({ status: 400, description: 'Invalid or rejected post' })
  @Post('posts')
  async createPost(
    @Body() createPostDto: CreatePostDto,
  ) {
    const adminId =
      await this.adminIdentityService.getAdminId();

    return this.forumService.createPost(
      createPostDto,
      adminId,
    );
  }

  @ApiOperation({ summary: 'Delete an administrator-owned post' })
  @ApiParam({
    name: 'id',
    type: Number,
  })
  @ApiResponse({ status: 200, description: 'Post deleted successfully' })
  @ApiResponse({ status: 403, description: 'Post does not belong to the administrator' })
  @ApiResponse({ status: 404, description: 'Post not found' })
  @Delete('posts/:id')
  async deletePost(
    @Param('id') id: string,
  ) {
    const adminId =
      await this.adminIdentityService.getAdminId();

    return this.forumService.deletePost(
      Number(id),
      adminId,
    );
  }
}
