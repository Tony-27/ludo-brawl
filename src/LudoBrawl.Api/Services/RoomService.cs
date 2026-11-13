using LudoBrawl.Api.Models;
using System.Security.Cryptography;

namespace LudoBrawl.Api.Services;

public class RoomService : IRoomService
{
    private const string CodeChars = "QWERTYUPASDFGHJKLZXCVBNM23456789";
    private readonly Dictionary<string, Room> _rooms = new();

    public Room CreateRoom(string hostName)
    {
        string code = RandomNumberGenerator.GetString(CodeChars, 5);
        Room newRoom = new Room { Code = code };

        Player host = new Player 
        { 
            Id = 1, 
            Name = hostName, 
            Color = Color.Red, 
            Token = RandomNumberGenerator.GetHexString(32) 
        };

        newRoom.Players.Add(host);
        newRoom.HostId = host.Id;
        newRoom.LastActivity = DateTimeOffset.UtcNow;
        _rooms[newRoom.Code] = newRoom;

        return newRoom;
    }

    public Player JoinRoom(string playerName, string roomCode)
    {
        throw new NotImplementedException();
    }

    public void LeaveRoom(string playerToken, string roomCode)
    {
        throw new NotImplementedException();
    }

    public Room? GetRoom(string roomCode)
    {
        return _rooms.GetValueOrDefault(roomCode);

    }
}