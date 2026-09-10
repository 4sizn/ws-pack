import type { ChatUser } from '../types'

interface AvatarProps {
  user: ChatUser
}

export function Avatar({ user }: AvatarProps) {
  return (
    <div className="avatar" style={{ background: user.color }} title={user.name}>
      {user.name.slice(-2)}
    </div>
  )
}
