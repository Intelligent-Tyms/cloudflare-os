import { createFileRoute } from '@tanstack/react-router'
import AdminSkillDetailPage from '../AdminSkillDetailPage'

// Detail page for one agent skill. `admin_` (trailing underscore) keeps the URL /admin/skills/…
// without nesting inside the /admin hub component, mirroring admin_.$section.
export const Route = createFileRoute('/admin_/skills/$skillName')({
  component: AdminSkillRoute,
})

function AdminSkillRoute() {
  const { skillName } = Route.useParams()
  return <AdminSkillDetailPage skillName={skillName} />
}
